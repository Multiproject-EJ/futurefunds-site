import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  resolveModel,
  resolveCredential,
  computeUsageCost,
  requestChatCompletion,
  requestEmbedding,
  withRetry
} from '../_shared/ai.ts';
import {
  hashRequestBody,
  buildCacheKey,
  fetchCachedCompletion,
  storeCachedCompletion,
  markCachedCompletionHit,
  resolveCacheTtlMinutes
} from '../_shared/cache.ts';
import { validateStage2Response, explainValidation } from '../_shared/prompt-validators.ts';
import { recordErrorLog } from '../_shared/observability.ts';
import {
  applyRequestSettings,
  getStageConfig,
  unpackRetrySettings
} from '../_shared/model-config.ts';
import { loadPromptTemplate, renderTemplate } from '../_shared/prompt-loader.ts';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

type JsonRecord = Record<string, unknown>;

type Stage2Result = {
  ticker: string;
  go_deep: boolean;
  summary: string;
  updated_at: string;
  status: 'ok' | 'failed';
  retrieval?: {
    hits: number;
    citations: RetrievedCitation[];
  };
  cache_hit?: boolean;
};

type Stage2Metrics = {
  total_survivors: number;
  pending: number;
  completed: number;
  failed: number;
  go_deep: number;
};

type RetrievedSnippet = {
  ref: string;
  chunk: string;
  source_type: string | null;
  title: string | null;
  published_at: string | null;
  source_url: string | null;
  similarity: number | null;
  token_length: number;
};

type RetrievedCitation = {
  ref: string;
  title: string | null;
  source_type: string | null;
  published_at: string | null;
  source_url: string | null;
  similarity: number | null;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const stageDefaults = getStageConfig('stage2');
const DEFAULT_STAGE2_MODEL = stageDefaults?.default_model ?? 'openrouter/gpt-5-mini';
const FALLBACK_STAGE2_MODEL = stageDefaults?.fallback_model ?? 'openai/gpt-4o-mini';
const EMBEDDING_MODEL_SLUG = stageDefaults?.embedding_model ?? 'openai/text-embedding-3-small';
const stageRequestSettings = stageDefaults?.request ?? null;
const stageRetry = unpackRetrySettings(stageDefaults?.retry);
const stageCacheTtlMinutes = resolveCacheTtlMinutes('stage2');
const systemPromptTemplate = loadPromptTemplate('stage2/system');
const userPromptTemplate = loadPromptTemplate('stage2/user');
const MAX_RETRIEVAL_SNIPPETS = 6;

const SURVIVOR_LABELS = new Set(['consider', 'borderline']);

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function asNumber(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isUuid(value: unknown) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function collectRoles(source: unknown, bucket: Set<string>) {
  if (!source) return;
  if (Array.isArray(source)) {
    source.forEach((entry) => collectRoles(entry, bucket));
    return;
  }
  if (typeof source === 'object') {
    Object.values(source as Record<string, unknown>).forEach((entry) => collectRoles(entry, bucket));
    return;
  }
  const parts = String(source)
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  parts.forEach((role) => bucket.add(role));
}

function hasAdminMarker(record: Record<string, unknown> | null | undefined) {
  if (!record) return false;
  const flagKeys = ['is_admin', 'admin', 'isAdmin', 'is_superadmin', 'superuser', 'staff', 'is_staff'];
  return flagKeys.some((key) => Boolean((record as Record<string, unknown>)[key]));
}

function isAdminContext(context: { user: JsonRecord | null; profile: JsonRecord | null; membership: JsonRecord | null }) {
  const { user, profile, membership } = context;
  if (hasAdminMarker(profile) || hasAdminMarker(membership) || hasAdminMarker(user ?? undefined)) {
    return true;
  }

  const bucket = new Set<string>();
  collectRoles(profile?.role, bucket);
  collectRoles((profile as JsonRecord | null)?.role_name, bucket);
  collectRoles((profile as JsonRecord | null)?.user_role, bucket);
  collectRoles((profile as JsonRecord | null)?.roles, bucket);
  collectRoles((profile as JsonRecord | null)?.role_tags, bucket);
  collectRoles((profile as JsonRecord | null)?.access_level, bucket);

  collectRoles(user?.app_metadata, bucket);
  collectRoles(user?.user_metadata, bucket);

  collectRoles(membership?.role, bucket);
  collectRoles(membership?.roles, bucket);
  collectRoles(membership?.access_level, bucket);

  const privileged = new Set(['admin', 'administrator', 'superadmin', 'owner', 'editor', 'staff']);
  for (const role of bucket) {
    if (privileged.has(role)) {
      return true;
    }
  }

  return false;
}

function normalizeLabel(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function survivorFilter(builder: ReturnType<typeof createClient>['from']) {
  return builder.filter('label', 'in', '("consider","borderline","CONSIDER","BORDERLINE")');
}

async function computeMetrics(client: ReturnType<typeof createClient>, runId: string): Promise<Stage2Metrics> {
  const { data, error } = await client.rpc('run_stage2_summary', { p_run_id: runId }).maybeSingle();
  if (error) throw error;
  return {
    total_survivors: Number(data?.total_survivors ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0),
    go_deep: Number(data?.go_deep ?? 0)
  };
}

function parsePlannerNotes(raw: unknown): JsonRecord {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as JsonRecord;
    } catch (error) {
      console.warn('Failed to parse planner notes JSON', error);
      return {};
    }
  }
  if (typeof raw === 'object') {
    return (raw as JsonRecord) ?? {};
  }
  return {};
}

function extractStageConfig(notes: JsonRecord, stageKey: string) {
  const planner = (notes?.planner ?? {}) as JsonRecord;
  const stage = (planner?.[stageKey] ?? {}) as JsonRecord;
  return {
    model: typeof stage?.model === 'string' ? stage.model : null,
    credentialId: typeof stage?.credentialId === 'string' ? stage.credentialId : null
  };
}

async function fetchTickerMeta(client: ReturnType<typeof createClient>, ticker: string) {
  const { data } = await client
    .from('tickers')
    .select('name, exchange, country, sector, industry')
    .eq('ticker', ticker)
    .maybeSingle();
  return data ?? {};
}

async function fetchSectorNotes(client: ReturnType<typeof createClient>, sector: string | null | undefined) {
  if (!sector) return null;
  const { data } = await client.from('sector_prompts').select('notes').eq('sector', sector).maybeSingle();
  return typeof data?.notes === 'string' && data.notes.trim().length ? data.notes.trim() : null;
}

async function fetchStage1Answer(client: ReturnType<typeof createClient>, runId: string, ticker: string) {
  const { data } = await client
    .from('answers')
    .select('answer_json')
    .eq('run_id', runId)
    .eq('ticker', ticker)
    .eq('stage', 1)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.answer_json ?? null) as JsonRecord | null;
}

function buildRetrievalQuery(
  ticker: string,
  meta: Record<string, unknown>,
  stage1: JsonRecord | null,
  sectorNotes: string | null
) {
  const lines: string[] = [];
  lines.push(`Ticker: ${ticker}`);
  if (meta.name) lines.push(`Name: ${String(meta.name)}`);
  if (meta.exchange) lines.push(`Exchange: ${String(meta.exchange)}`);
  if (meta.country) lines.push(`Country: ${String(meta.country)}`);
  if (meta.sector) lines.push(`Sector: ${String(meta.sector)}`);
  if (meta.industry) lines.push(`Industry: ${String(meta.industry)}`);

  const label = stage1?.label ?? stage1?.classification ?? null;
  if (label) lines.push(`Stage 1 label: ${String(label)}`);

  const reasons = Array.isArray(stage1?.reasons)
    ? (stage1?.reasons as unknown[]).slice(0, 4).map((reason) => String(reason))
    : [];
  if (reasons.length) {
    lines.push(`Stage 1 reasons: ${reasons.join('; ')}`);
  }

  if (stage1?.summary && typeof stage1.summary === 'string') {
    lines.push(`Stage 1 summary: ${stage1.summary}`);
  }

  if (sectorNotes) {
    lines.push(`Sector heuristics: ${sectorNotes}`);
  }

  return lines.join('\n');
}

function snippetsToCitations(snippets: RetrievedSnippet[]): RetrievedCitation[] {
  return snippets.map((snippet) => ({
    ref: snippet.ref,
    title: snippet.title,
    source_type: snippet.source_type,
    published_at: snippet.published_at,
    source_url: snippet.source_url,
    similarity: snippet.similarity
  }));
}

async function fetchRetrievedSnippets(
  client: ReturnType<typeof createClient>,
  ticker: string,
  query: string,
  options: {
    model: Awaited<ReturnType<typeof resolveModel>> | null;
    credential: Awaited<ReturnType<typeof resolveCredential>> | null;
    limit?: number;
  }
): Promise<{ snippets: RetrievedSnippet[]; citations: RetrievedCitation[]; tokens: number }> {
  if (!query || !query.trim() || !options.model || !options.credential) {
    return { snippets: [], citations: [], tokens: 0 };
  }

  const embeddingResponse = await requestEmbedding(options.model, options.credential, query.slice(0, 6_000));
  const vector = embeddingResponse?.data?.[0]?.embedding as number[] | undefined;
  if (!vector) {
    return { snippets: [], citations: [], tokens: 0 };
  }

  const { data, error } = await client.rpc('match_doc_chunks', {
    query_embedding: vector,
    query_ticker: ticker || null,
    match_limit: Math.max(1, Math.min(options.limit ?? MAX_RETRIEVAL_SNIPPETS, 12))
  });
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const snippets: RetrievedSnippet[] = rows.map((row: Record<string, unknown>, index: number) => {
    const text = String(row.chunk ?? '').trim();
    const truncated = text.length > 900 ? `${text.slice(0, 900)}…` : text;
    return {
      ref: `D${index + 1}`,
      chunk: truncated,
      source_type: (row.source_type ?? row.source ?? null) as string | null,
      title: (row.title ?? null) as string | null,
      published_at: (row.published_at ?? null) as string | null,
      source_url: (row.source_url ?? null) as string | null,
      similarity: row.similarity != null ? Number(row.similarity) : null,
      token_length: Number(row.token_length ?? 0)
    };
  });

  const usage = (embeddingResponse?.usage ?? {}) as Record<string, unknown>;
  const tokens = Number(usage.total_tokens ?? usage.prompt_tokens ?? 0);

  return {
    snippets,
    citations: snippetsToCitations(snippets),
    tokens: Number.isFinite(tokens) ? tokens : 0
  };
}

function formatStage1Block(stage1: JsonRecord | null) {
  const lines: string[] = [];
  const stage1Label = stage1?.label ?? stage1?.classification ?? null;
  if (stage1Label) {
    lines.push(`Stage 1 classification: ${stage1Label}`);
  }
  const reasons = Array.isArray(stage1?.reasons) ? stage1.reasons : [];
  if (reasons.length) {
    lines.push('Stage 1 reasons:');
    reasons.slice(0, 4).forEach((reason: unknown, index: number) => {
      lines.push(`  ${index + 1}. ${String(reason)}`);
    });
  }
  const flags = stage1?.flags as JsonRecord | null;
  if (flags && typeof flags === 'object') {
    const flagEntries = Object.entries(flags)
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => `${key}: ${value}`);
    if (flagEntries.length) {
      lines.push('Risk flags:');
      flagEntries.slice(0, 4).forEach((flag) => lines.push(`  - ${flag}`));
    }
  }
  if (typeof stage1?.summary === 'string' && stage1.summary.trim()) {
    lines.push('Stage 1 summary:');
    lines.push(stage1.summary.trim());
  }
  if (!lines.length) {
    lines.push('Stage 1 context unavailable.');
  }
  return lines.join('\n');
}

function formatSectorNotesBlock(sectorNotes: string | null) {
  if (typeof sectorNotes === 'string' && sectorNotes.trim()) {
    return `Sector heuristics to consider:\n${sectorNotes.trim()}`;
  }
  return 'Sector heuristics unavailable.';
}

function formatRetrievalBlock(retrieved: RetrievedSnippet[]) {
  if (!retrieved.length) {
    return 'No retrieval snippets available for this ticker. Cite fundamental context only.';
  }
  const lines: string[] = ['Retrieved context (cite facts using [D1], [D2], etc.):'];
  retrieved.forEach((snippet) => {
    lines.push(`[${snippet.ref}] ${snippet.chunk}`);
    const parts: string[] = [];
    if (snippet.title) parts.push(snippet.title);
    if (snippet.source_type) parts.push(snippet.source_type);
    if (snippet.published_at) {
      try {
        parts.push(new Date(snippet.published_at).toISOString().slice(0, 10));
      } catch (_error) {
        // ignore invalid date formats
      }
    }
    const sourceLine = parts.length ? parts.join(' · ') : 'Source metadata unavailable';
    lines.push(`Source: ${sourceLine}`);
    if (snippet.source_url) {
      lines.push(`URL: ${snippet.source_url}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

async function buildUserPrompt(
  ticker: string,
  meta: Record<string, unknown>,
  stage1: JsonRecord | null,
  sectorNotes: string | null,
  retrieved: RetrievedSnippet[]
) {
  const template = await userPromptTemplate;
  return renderTemplate(template, {
    ticker,
    name: String(meta.name ?? 'Unknown'),
    exchange: String(meta.exchange ?? 'n/a'),
    country: String(meta.country ?? 'n/a'),
    sector: String(meta.sector ?? 'n/a'),
    industry: String(meta.industry ?? 'n/a'),
    stage1_block: formatStage1Block(stage1),
    sector_notes_block: formatSectorNotesBlock(sectorNotes),
    retrieval_block: formatRetrievalBlock(retrieved)
  });
}

function extractSummary(answer: JsonRecord) {
  const verdict = answer?.verdict as JsonRecord | undefined;
  if (verdict && typeof verdict.summary === 'string' && verdict.summary.trim()) {
    return verdict.summary.trim();
  }

  const nextSteps = Array.isArray(answer?.next_steps) ? answer?.next_steps : [];
  if (nextSteps.length) {
    return String(nextSteps[0]);
  }

  const scores = answer?.scores as JsonRecord | undefined;
  if (scores && typeof scores === 'object') {
    for (const [key, value] of Object.entries(scores)) {
      if (value && typeof (value as JsonRecord).rationale === 'string' && (value as JsonRecord).rationale.trim()) {
        return `${key}: ${(value as JsonRecord).rationale}`;
      }
    }
  }

  return '—';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing required environment configuration for stage2-consume');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const limit = clamp(asNumber(payload?.limit, 4), 1, 15);
  const requestedRunId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  const runId = isUuid(requestedRunId) ? requestedRunId : null;

  const serviceAuth = resolveServiceAuth(req);
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const accessToken = tokenMatch?.[1]?.trim();

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  if (!serviceAuth.authorized) {
    if (!accessToken) {
      return jsonResponse(401, { error: 'Missing bearer token' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.error('Invalid session token', userError);
      return jsonResponse(401, { error: 'Invalid or expired session token' });
    }

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
      supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
    ]);

    if (profileResult.error) {
      console.error('Failed to load profile', profileResult.error);
    }
    if (membershipResult.error) {
      console.error('Failed to load membership', membershipResult.error);
    }

    const context = {
      user: userData.user as JsonRecord,
      profile: (profileResult.data ?? null) as JsonRecord | null,
      membership: (membershipResult.data ?? null) as JsonRecord | null
    };

    if (!isAdminContext(context)) {
      return jsonResponse(403, { error: 'Admin access required' });
    }
  }

  let runRow;
  if (runId) {
    const { data, error } = await supabaseAdmin
      .from('runs')
      .select('id, status, stop_requested, notes')
      .eq('id', runId)
      .maybeSingle();
    if (error) {
      console.error('Failed to load run', error);
      return jsonResponse(500, { error: 'Failed to load run', details: error.message });
    }
    runRow = data;
  } else {
    const { data, error } = await supabaseAdmin
      .from('runs')
      .select('id, status, stop_requested, notes')
      .in('status', ['running', 'queued'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('Failed to select latest run', error);
      return jsonResponse(500, { error: 'Failed to select latest run', details: error.message });
    }
    runRow = data;
  }

  if (!runRow) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  if (runRow.stop_requested) {
    const metrics = await computeMetrics(supabaseAdmin, runRow.id);
    return jsonResponse(409, {
      error: 'Run flagged to stop',
      run_id: runRow.id,
      metrics
    });
  }

  const plannerNotes = parsePlannerNotes(runRow.notes ?? null);
  const stageConfig = extractStageConfig(plannerNotes, 'stage2');

  let modelRecord;
  const desiredModel = stageConfig.model?.trim() || DEFAULT_STAGE2_MODEL;
  try {
    modelRecord = await resolveModel(supabaseAdmin, desiredModel, FALLBACK_STAGE2_MODEL);
  } catch (error) {
    console.error('Stage 2 model configuration error', error);
    return jsonResponse(500, {
      error: 'Stage 2 model not configured',
      details: error instanceof Error ? error.message : String(error)
    });
  }

  let credentialRecord;
  try {
    const provider = modelRecord.provider ?? 'openai';
    const envKeys = provider.toLowerCase() === 'openrouter'
      ? ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']
      : ['OPENAI_API_KEY'];
    credentialRecord = await resolveCredential(supabaseAdmin, {
      credentialId: stageConfig.credentialId,
      provider,
      preferScopes: ['automation', 'editor'],
      allowEnvFallback: true,
      envKeys
    });
  } catch (error) {
    console.error('Stage 2 credential configuration error', error);
    return jsonResponse(500, {
      error: 'Stage 2 credential not configured',
      details: error instanceof Error ? error.message : String(error)
    });
  }

  let embeddingModelRecord: Awaited<ReturnType<typeof resolveModel>> | null = null;
  let embeddingCredentialRecord: Awaited<ReturnType<typeof resolveCredential>> | null = null;
  try {
    embeddingModelRecord = await resolveModel(supabaseAdmin, EMBEDDING_MODEL_SLUG, EMBEDDING_MODEL_SLUG);
  } catch (error) {
    console.warn('Stage 2 retrieval embedding model unavailable', error);
  }

  if (embeddingModelRecord) {
    try {
      embeddingCredentialRecord = await resolveCredential(supabaseAdmin, {
        credentialId: null,
        provider: embeddingModelRecord.provider,
        preferScopes: ['automation', 'rag', 'editor'],
        allowEnvFallback: true,
        envKeys: ['OPENAI_API_KEY']
      });
    } catch (error) {
      console.warn('Stage 2 retrieval embedding credential unavailable', error);
      embeddingCredentialRecord = null;
    }
  }

  const { data: pending, error: pendingError } = await survivorFilter(
    supabaseAdmin
      .from('run_items')
      .select('ticker, label, spend_est_usd')
      .eq('run_id', runRow.id)
      .eq('status', 'ok')
      .eq('stage', 1)
      .order('updated_at', { ascending: true })
  ).limit(limit);

  if (pendingError) {
    console.error('Failed to load Stage 2 candidates', pendingError);
    return jsonResponse(500, { error: 'Failed to load Stage 2 candidates', details: pendingError.message });
  }

  const items = pending ?? [];
  if (!items.length) {
    const metrics = await computeMetrics(supabaseAdmin, runRow.id);
    const message = metrics.pending === 0
      ? 'Stage 2 complete or no survivors available.'
      : 'No eligible Stage 2 survivors pending.';
    return jsonResponse(200, {
      run_id: runRow.id,
      processed: 0,
      failed: 0,
      metrics,
      results: [],
      model: modelRecord.slug,
      message
    });
  }

  const results: Stage2Result[] = [];
  let cacheHits = 0;
  let processed = 0;
  let failures = 0;
  let totalRetrievalHits = 0;
  let totalEmbeddingTokens = 0;

  for (const item of items) {
    const ticker = item.ticker as string;
    const startedAt = new Date().toISOString();
    let rawMessage = '{}';
    let parsed: JsonRecord = {};
    let retrievalMeta: JsonRecord | null = null;

    try {
      const meta = await fetchTickerMeta(supabaseAdmin, ticker);
      const sector = typeof meta?.sector === 'string' ? (meta.sector as string) : null;
      const sectorNotes = await fetchSectorNotes(supabaseAdmin, sector);
      const stage1Answer = await fetchStage1Answer(supabaseAdmin, runRow.id, ticker);

      const retrievalQuery = buildRetrievalQuery(ticker, meta ?? {}, stage1Answer, sectorNotes);
      const retrieval = await fetchRetrievedSnippets(supabaseAdmin, ticker, retrievalQuery, {
        model: embeddingModelRecord,
        credential: embeddingCredentialRecord,
        limit: MAX_RETRIEVAL_SNIPPETS
      });
      totalRetrievalHits += retrieval.snippets.length;
      totalEmbeddingTokens += retrieval.tokens;
      retrievalMeta = {
        hits: retrieval.snippets.length,
        tokens: retrieval.tokens,
        citations: retrieval.citations
      };

      if (!SURVIVOR_LABELS.has(normalizeLabel(item.label))) {
        results.push({
          ticker,
          go_deep: false,
          summary: 'Ticker no longer qualifies for Stage 2.',
          updated_at: startedAt,
          status: 'failed'
        });
        await supabaseAdmin
          .from('run_items')
          .update({ stage: 1, status: 'failed', updated_at: new Date().toISOString() })
          .eq('run_id', runRow.id)
          .eq('ticker', ticker);
        failures += 1;
        continue;
      }

      const [systemPrompt, userPrompt] = await Promise.all([
        systemPromptTemplate,
        buildUserPrompt(ticker, meta, stage1Answer, sectorNotes, retrieval.snippets)
      ]);
      const requestBody = applyRequestSettings(
        {
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        },
        stageRequestSettings
      );
      const promptHash = await hashRequestBody(requestBody);
      const cacheKey = buildCacheKey(['stage2', ticker, promptHash]);
      let cacheHit = false;
      let usage: Record<string, unknown> | null = null;
      let completion: Record<string, unknown> | null = null;

      try {
        const cached = await fetchCachedCompletion(supabaseAdmin, modelRecord.slug, cacheKey);
        if (cached) {
          cacheHit = true;
          cacheHits += 1;
          usage = cached.usage ?? null;
          completion = cached.response_body ?? null;
          await markCachedCompletionHit(supabaseAdmin, cached.id);
        }
      } catch (error) {
        console.warn('Stage 2 cache lookup failed', error);
      }

      if (!completion) {
        completion = await withRetry(
          stageRetry.attempts,
          stageRetry.backoffMs,
          () => requestChatCompletion(modelRecord, credentialRecord, requestBody),
          { jitter: stageRetry.jitter }
        );
        const completionAny = completion as { usage?: Record<string, unknown> };
        usage = completionAny?.usage ?? null;
        try {
          await storeCachedCompletion(
            supabaseAdmin,
            modelRecord.slug,
            cacheKey,
            promptHash,
            requestBody,
            completion as Record<string, unknown>,
            usage ?? null,
            { ttlMinutes: stageCacheTtlMinutes, context: retrievalMeta ?? undefined }
          );
        } catch (error) {
          console.warn('Stage 2 cache write failed', error);
        }
      }

      const completionAny = completion as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      rawMessage = completionAny?.choices?.[0]?.message?.content ?? '{}';
      try {
        parsed = JSON.parse(rawMessage);
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : String(error);
        const parseError = new Error(`Failed to parse model response JSON: ${parseMessage}`);
        (parseError as Error & { logPayload?: JsonRecord }).logPayload = {
          raw_response: rawMessage,
          parse_error: parseMessage,
          retrieval: retrievalMeta
        };
        throw parseError;
      }

      const validation = validateStage2Response(parsed);
      if (!validation.valid) {
        const validationError = new Error(
          `Stage 2 schema validation failed: ${explainValidation(validation)}`
        );
        (validationError as Error & { logPayload?: JsonRecord }).logPayload = {
          raw_response: rawMessage,
          validation_errors: validation.errors,
          parsed,
          retrieval: retrievalMeta
        };
        throw validationError;
      }

      const effectiveUsage = cacheHit ? {} : (usage ?? {});
      const { cost, promptTokens, completionTokens } = computeUsageCost(modelRecord, effectiveUsage);
      const verdict = (parsed?.verdict ?? null) as JsonRecord | null;
      const goDeep = Boolean(verdict?.go_deep);

      const enrichedAnswer: JsonRecord = {
        ...parsed,
        context_citations: retrieval.citations
      };
      if (cacheHit) {
        enrichedAnswer.cache_hit = true;
      }

      await supabaseAdmin.from('answers').insert({
        run_id: runRow.id,
        ticker,
        stage: 2,
        question_group: 'medium',
        answer_json: enrichedAnswer,
        tokens_in: promptTokens,
        tokens_out: completionTokens,
        cost_usd: cost,
        created_at: startedAt
      });

      await supabaseAdmin
        .from('run_items')
        .update({
          stage: 2,
          status: 'ok',
          stage2_go_deep: goDeep,
          spend_est_usd: Number(item.spend_est_usd ?? 0) + cost,
          updated_at: new Date().toISOString()
        })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      if (cost > 0) {
        await supabaseAdmin.from('cost_ledger').insert({
          run_id: runRow.id,
          stage: 2,
          model: modelRecord.slug,
          tokens_in: promptTokens,
          tokens_out: completionTokens,
          cost_usd: cost,
          created_at: startedAt
        });
      }

      results.push({
        ticker,
        go_deep: goDeep,
        summary: extractSummary(enrichedAnswer),
        updated_at: startedAt,
        status: 'ok',
        retrieval: {
          hits: retrieval.snippets.length,
          citations: retrieval.citations
        },
        cache_hit: cacheHit
      });
      processed += 1;
    } catch (error) {
      console.error(`Stage 2 processing failed for ${ticker}`, error);
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);

      const basePayload: JsonRecord =
        error && typeof (error as { logPayload?: JsonRecord }).logPayload === 'object'
          ? { ...(error as { logPayload?: JsonRecord }).logPayload }
          : {};
      if (!basePayload.raw_response) {
        basePayload.raw_response = rawMessage;
      }
      if (!basePayload.retrieval && retrievalMeta) {
        basePayload.retrieval = retrievalMeta;
      }
      basePayload.error_message = message;
      basePayload.ticker = ticker;

      await recordErrorLog(supabaseAdmin, {
        context: 'stage2-consume',
        message,
        runId: runRow.id,
        ticker,
        stage: 2,
        promptId: 'stage2-medium',
        payload: {
          ...basePayload,
          run_item: {
            status: item.status,
            stage: item.stage,
            label: item.label,
            spend_est_usd: item.spend_est_usd
          }
        },
        metadata: {
          planner_model: stageConfig.model,
          planner_credential: stageConfig.credentialId
        }
      });

      await supabaseAdmin
        .from('run_items')
        .update({ stage: 2, status: 'failed', stage2_go_deep: null, updated_at: new Date().toISOString() })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      results.push({
        ticker,
        go_deep: false,
        summary: message,
        updated_at: startedAt,
        status: 'failed'
      });
    }
  }

  const metrics = await computeMetrics(supabaseAdmin, runRow.id);
  const cacheNote = cacheHits > 0 ? ` (${cacheHits} cached)` : '';
  const message = processed > 0
    ? `Processed ${processed} ticker${processed === 1 ? '' : 's'}${cacheNote}. Pending survivors: ${metrics.pending}.`
    : 'No tickers processed.';

  return jsonResponse(200, {
    run_id: runRow.id,
    processed,
    failed: failures,
    metrics,
    results,
    model: modelRecord.slug,
    message,
    cache_hits: cacheHits,
    retrieval: {
      total_hits: totalRetrievalHits,
      embedding_tokens: totalEmbeddingTokens
    }
  });
});
