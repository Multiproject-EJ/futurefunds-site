import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import type { EnsembleSummary } from './ensembles.ts';
import {
  computeEnsembleScore,
  compareConvictionLevel,
  normalizeConviction,
  normalizeSummary
} from '../../../shared/notification-utils.js';

export type NotificationChannel = {
  id: string;
  type: 'email' | 'slack_webhook';
  label: string;
  target: string;
  is_active: boolean;
  min_score: number | null;
  conviction_levels: string[];
  watchlist_ids: string[];
  metadata: Record<string, unknown>;
};

export type HighConvictionContext = {
  runId: string;
  watchlistId: string | null;
  ticker: string;
  company?: string | null;
  verdict?: string | null;
  conviction?: string | null;
  summaryText?: string | null;
  dimensionSummaries: EnsembleSummary[];
  stage3Summary?: Record<string, unknown>;
  runLabel?: string | null;
};

type GenericClient = SupabaseClient<any, any, any>;

type DeliveryResult = { status: 'sent' | 'failed'; error?: string | null };

type NormalizedContext = {
  runId: string;
  ticker: string;
  company: string | null;
  convictionLevel: 'very_high' | 'high' | 'medium' | 'low' | 'unknown';
  convictionText: string | null;
  ensembleScore: number | null;
  verdict: string | null;
  summary: string | null;
  watchlistId: string | null;
  runLabel: string | null;
  dimensionSummaries: EnsembleSummary[];
  stage3Summary: Record<string, unknown>;
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function metadataToRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeChannel(row: Record<string, unknown>): NotificationChannel | null {
  const id = typeof row.id === 'string' ? row.id : null;
  const type = typeof row.type === 'string' ? row.type : null;
  const label = typeof row.label === 'string' ? row.label : null;
  const target = typeof row.target === 'string' ? row.target : null;
  if (!id || !type || !label || !target) return null;
  const minScore = row.min_score != null ? Number(row.min_score) : null;
  return {
    id,
    type: type === 'email' ? 'email' : 'slack_webhook',
    label,
    target,
    is_active: row.is_active !== false,
    min_score: Number.isFinite(minScore) ? Number(minScore) : null,
    conviction_levels: normalizeStringArray(row.conviction_levels).map((level) =>
      level.toLowerCase().replace(/\s+/g, '_')
    ),
    watchlist_ids: normalizeStringArray(row.watchlist_ids),
    metadata: metadataToRecord(row.metadata)
  };
}

function normalizeContext(context: HighConvictionContext): NormalizedContext {
  const stage3Summary = context.stage3Summary && typeof context.stage3Summary === 'object'
    ? (context.stage3Summary as Record<string, unknown>)
    : {};
  const summaryCandidate =
    normalizeSummary(context.summaryText) ||
    normalizeSummary(stage3Summary.thesis) ||
    normalizeSummary(stage3Summary.summary) ||
    normalizeSummary(stage3Summary.narrative);
  const convictionField =
    stage3Summary.conviction ?? stage3Summary.confidence ?? stage3Summary.signal ?? context.conviction ?? null;
  const { level, text } = normalizeConviction(convictionField);
  const verdict = normalizeSummary(stage3Summary.verdict) || normalizeSummary(context.verdict);
  const company = normalizeSummary(context.company) || normalizeSummary(stage3Summary.company) || null;
  const ensembleScore = computeEnsembleScore(context.dimensionSummaries);
  return {
    runId: context.runId,
    ticker: context.ticker,
    company,
    convictionLevel: level,
    convictionText: text,
    ensembleScore,
    verdict,
    summary: summaryCandidate,
    watchlistId: context.watchlistId ?? null,
    runLabel: context.runLabel ?? null,
    dimensionSummaries: context.dimensionSummaries,
    stage3Summary
  };
}

async function fetchActiveChannels(client: GenericClient): Promise<NotificationChannel[]> {
  const { data, error } = await client
    .from('notification_channels')
    .select('*')
    .eq('is_active', true);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row) => normalizeChannel(row as Record<string, unknown>))
    .filter((entry): entry is NotificationChannel => Boolean(entry));
}

function matchesChannel(channel: NotificationChannel, context: NormalizedContext): boolean {
  if (channel.min_score != null && context.ensembleScore != null && context.ensembleScore < channel.min_score) {
    return false;
  }
  if (channel.conviction_levels.length) {
    const normalized = context.convictionLevel;
    if (!channel.conviction_levels.includes(normalized)) {
      // allow matching "high" to "very_high" if requested
      if (!(normalized === 'very_high' && channel.conviction_levels.includes('high'))) {
        return false;
      }
    }
  }
  if (channel.watchlist_ids.length) {
    if (!context.watchlistId || !channel.watchlist_ids.includes(context.watchlistId)) {
      return false;
    }
  }
  return true;
}

function buildTickerUrl(ticker: string, runId: string | null): string | null {
  const base = Deno.env.get('ALERTS_PUBLIC_BASE_URL') || Deno.env.get('SITE_BASE_URL') || '';
  if (!base) return null;
  const trimmed = base.replace(/\/$/, '');
  const params = new URLSearchParams({ ticker });
  if (runId) {
    params.set('run', runId);
  }
  return `${trimmed}/ticker.html?${params.toString()}`;
}

function buildSlackMessage(context: NormalizedContext): string {
  const lines: string[] = [];
  lines.push(`*${context.ticker}${context.company ? ` — ${context.company}` : ''}*`);
  const convictionLabel = context.convictionText || context.convictionLevel.replace('_', ' ');
  lines.push(`Conviction: ${convictionLabel}`);
  if (context.ensembleScore != null) {
    lines.push(`Ensemble score: ${context.ensembleScore}`);
  }
  if (context.verdict) {
    lines.push(`Verdict: ${context.verdict}`);
  }
  if (context.summary) {
    lines.push(`Summary: ${context.summary}`);
  }
  const highlights = context.dimensionSummaries
    .slice(0, 3)
    .map((entry) => `${entry.dimension.name}: ${entry.verdict}${entry.ensembleScore != null ? ` (${Math.round(entry.ensembleScore)})` : ''}`);
  if (highlights.length) {
    lines.push(`Highlights: ${highlights.join('; ')}`);
  }
  const link = buildTickerUrl(context.ticker, context.runId);
  if (link) {
    lines.push(`Detail: ${link}`);
  }
  return lines.join('\n');
}

function buildEmailBody(context: NormalizedContext): { subject: string; text: string; html: string } {
  const convictionLabel = context.convictionText || context.convictionLevel.replace('_', ' ');
  const subjectParts = [`${context.ticker}`];
  if (context.company) subjectParts.push(context.company);
  subjectParts.push(convictionLabel ? `(${convictionLabel})` : '(conviction update)');
  const subject = `FutureFunds alert: ${subjectParts.join(' ')}`;
  const link = buildTickerUrl(context.ticker, context.runId);
  const bulletItems = context.dimensionSummaries.slice(0, 4).map((entry) => {
    const label = `${entry.dimension.name}: ${entry.verdict}`;
    const score = entry.ensembleScore != null ? ` — ${Math.round(entry.ensembleScore)}` : '';
    return `<li><strong>${escapeHtml(label)}</strong>${escapeHtml(score)}<br/>${escapeHtml(entry.summary || '')}</li>`;
  });
  const htmlParts = [
    `<p><strong>${escapeHtml(context.ticker)}${context.company ? escapeHtml(` — ${context.company}`) : ''}</strong></p>`,
    `<p>Conviction: ${escapeHtml(convictionLabel)}</p>`
  ];
  if (context.ensembleScore != null) {
    htmlParts.push(`<p>Ensemble score: <strong>${escapeHtml(String(context.ensembleScore))}</strong></p>`);
  }
  if (context.verdict) {
    htmlParts.push(`<p>Verdict: ${escapeHtml(context.verdict)}</p>`);
  }
  if (context.summary) {
    htmlParts.push(`<p>${escapeHtml(context.summary)}</p>`);
  }
  if (bulletItems.length) {
    htmlParts.push(`<ul>${bulletItems.join('')}</ul>`);
  }
  if (link) {
    htmlParts.push(`<p><a href="${escapeHtml(link)}">Open latest deep dive →</a></p>`);
  }
  const html = htmlParts.join('\n');

  const textLines = [
    `${context.ticker}${context.company ? ` — ${context.company}` : ''}`,
    `Conviction: ${convictionLabel}`
  ];
  if (context.ensembleScore != null) {
    textLines.push(`Ensemble score: ${context.ensembleScore}`);
  }
  if (context.verdict) {
    textLines.push(`Verdict: ${context.verdict}`);
  }
  if (context.summary) {
    textLines.push(`Summary: ${context.summary}`);
  }
  context.dimensionSummaries.slice(0, 4).forEach((entry) => {
    const score = entry.ensembleScore != null ? ` (${Math.round(entry.ensembleScore)})` : '';
    textLines.push(`- ${entry.dimension.name}: ${entry.verdict}${score} — ${entry.summary ?? ''}`);
  });
  if (link) {
    textLines.push(`Detail: ${link}`);
  }
  const text = textLines.join('\n');
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendSlack(channel: NotificationChannel, context: NormalizedContext): Promise<DeliveryResult> {
  try {
    const body = { text: buildSlackMessage(context) };
    const response = await fetch(channel.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      return { status: 'failed', error: `Slack webhook returned ${response.status}: ${detail}` };
    }
    return { status: 'sent' };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendEmail(channel: NotificationChannel, context: NormalizedContext): Promise<DeliveryResult> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL');
  if (!apiKey || !fromEmail) {
    return { status: 'failed', error: 'Resend environment not configured' };
  }
  const targets = channel.target.split(/[,;\s]+/).map((entry) => entry.trim()).filter(Boolean);
  if (!targets.length) {
    return { status: 'failed', error: 'No recipient provided' };
  }
  const payload = buildEmailBody(context);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: targets,
        subject: payload.subject,
        text: payload.text,
        html: payload.html
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      return { status: 'failed', error: `Resend API returned ${response.status}: ${detail}` };
    }
    return { status: 'sent' };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function hasRecentSuccess(client: GenericClient, channelId: string, runId: string, ticker: string): Promise<boolean> {
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('notification_events')
    .select('id')
    .eq('channel_id', channelId)
    .eq('run_id', runId)
    .eq('ticker', ticker)
    .eq('stage', 3)
    .eq('status', 'sent')
    .gte('created_at', twelveHoursAgo)
    .limit(1);
  if (error) {
    console.warn('notification_events lookup failed', error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function deliver(channel: NotificationChannel, context: NormalizedContext): Promise<DeliveryResult> {
  if (channel.type === 'email') {
    return sendEmail(channel, context);
  }
  return sendSlack(channel, context);
}

export async function dispatchHighConvictionAlerts(client: GenericClient, context: HighConvictionContext): Promise<void> {
  const normalized = normalizeContext(context);
  if (!normalized.summary && !normalized.verdict) {
    // Require at least some substance before alerting.
    return;
  }
  const channels = await fetchActiveChannels(client);
  if (!channels.length) return;
  const eligible = channels.filter((channel) => matchesChannel(channel, normalized));
  if (!eligible.length) return;
  for (const channel of eligible) {
    try {
      if (await hasRecentSuccess(client, channel.id, normalized.runId, normalized.ticker)) {
        continue;
      }
      const result = await deliver(channel, normalized);
      const payload = {
        run_id: normalized.runId,
        ticker: normalized.ticker,
        company: normalized.company,
        summary: normalized.summary,
        conviction: normalized.convictionText ?? normalized.convictionLevel,
        ensemble_score: normalized.ensembleScore,
        verdict: normalized.verdict,
        run_label: normalized.runLabel,
        channel_label: channel.label,
        dimension_summaries: normalized.dimensionSummaries,
        stage3_summary: normalized.stage3Summary
      };
      await client.from('notification_events').insert({
        channel_id: channel.id,
        run_id: normalized.runId,
        ticker: normalized.ticker,
        stage: 3,
        conviction: normalized.convictionText ?? normalized.convictionLevel,
        verdict: normalized.verdict,
        ensemble_score: normalized.ensembleScore,
        status: result.status,
        error: result.error ?? null,
        dispatched_at: result.status === 'sent' ? new Date().toISOString() : null,
        payload
      });
    } catch (error) {
      console.error('Failed to dispatch notification', error);
      await client.from('notification_events').insert({
        channel_id: channel.id,
        run_id: normalized.runId,
        ticker: normalized.ticker,
        stage: 3,
        conviction: normalized.convictionText ?? normalized.convictionLevel,
        verdict: normalized.verdict,
        ensemble_score: normalized.ensembleScore,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        payload: {
          run_id: normalized.runId,
          ticker: normalized.ticker,
          channel_label: channel.label,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

export { computeEnsembleScore, compareConvictionLevel };
