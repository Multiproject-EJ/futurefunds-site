import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type JsonRecord = Record<string, unknown>;

type Stage2Result = {
  ticker: string;
  go_deep: boolean;
  summary: string;
  updated_at: string;
  status: 'ok' | 'failed';
};

type Stage2Metrics = {
  total_survivors: number;
  pending: number;
  completed: number;
  failed: number;
  go_deep: number;
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

const MODEL_ALIASES: Record<string, string> = {
  '4o-mini': 'gpt-4o-mini',
  '5-mini': 'gpt-5-mini',
  '5': 'gpt-5-preview'
};

const PRICE_LOOKUP: Record<string, { in: number; out: number }> = {
  '4o-mini': { in: 0.15, out: 0.6 },
  '5-mini': { in: 0.25, out: 2.0 },
  '5': { in: 1.25, out: 10.0 }
};

const SURVIVOR_LABELS = new Set(['consider', 'borderline']);

const SYSTEM_PROMPT =
  `You are a buy-side equity analyst performing a thematic scoring pass. ` +
  `Return strict JSON with the shape {"scores": {"profitability": {"score": int, "rationale": string}, "reinvestment": {"score": int, "rationale": string}, "leverage": {"score": int, "rationale": string}, "moat": {"score": int, "rationale": string}, "timing": {"score": int, "rationale": string}}, ` +
  `"verdict": {"go_deep": boolean, "summary": string, "risks": [string], "opportunities": [string]}, "next_steps": [string]}. ` +
  `Scores must be integers from 0-10. Keep rationales under 160 characters and ground all commentary in the provided facts.`;

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

function buildUserPrompt(
  ticker: string,
  meta: Record<string, unknown>,
  stage1: JsonRecord | null,
  sectorNotes: string | null
) {
  const lines: string[] = [];
  lines.push(`Ticker: ${ticker}`);
  lines.push(`Name: ${meta.name ?? 'Unknown'}`);
  lines.push(`Exchange: ${meta.exchange ?? 'n/a'}`);
  lines.push(`Country: ${meta.country ?? 'n/a'}`);
  lines.push(`Sector: ${meta.sector ?? 'n/a'}`);
  lines.push(`Industry: ${meta.industry ?? 'n/a'}`);
  lines.push('');

  const stage1Label = stage1?.label ?? stage1?.classification ?? null;
  if (stage1Label) {
    lines.push(`Stage 1 classification: ${stage1Label}`);
  }
  const reasons = Array.isArray(stage1?.reasons) ? stage1?.reasons : [];
  if (reasons && reasons.length) {
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

  if (sectorNotes) {
    lines.push('');
    lines.push('Sector heuristics to consider:');
    lines.push(sectorNotes);
  }

  lines.push('');
  lines.push('Deliver mid-depth scoring with crisp rationales tied to these facts.');
  return lines.join('\n');
}

async function callOpenAI(
  apiKey: string,
  model: string,
  ticker: string,
  meta: Record<string, unknown>,
  stage1: JsonRecord | null,
  sectorNotes: string | null
) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(ticker, meta, stage1, sectorNotes) }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text}`);
  }

  const payload = await response.json();
  const message = payload?.choices?.[0]?.message?.content ?? '{}';
  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(message);
  } catch (error) {
    throw new Error(`Failed to parse OpenAI response JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const usage = payload?.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  return { parsed, usage };
}

function computeCost(modelKey: string, usage: { prompt_tokens?: number; completion_tokens?: number }) {
  const price = PRICE_LOOKUP[modelKey] ?? PRICE_LOOKUP['5-mini'];
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const inCost = (promptTokens / 1_000_000) * price.in;
  const outCost = (completionTokens / 1_000_000) * price.out;
  return {
    cost: inCost + outCost,
    promptTokens,
    completionTokens
  };
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
  const openaiKey = Deno.env.get('OPENAI_API_KEY');

  if (!supabaseUrl || !serviceRoleKey || !openaiKey) {
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

  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const accessToken = tokenMatch?.[1]?.trim();
  if (!accessToken) {
    return jsonResponse(401, { error: 'Missing bearer token' });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

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

  const modelKeyRaw = ((): string => {
    try {
      const notes = typeof runRow.notes === 'string' ? JSON.parse(runRow.notes) : runRow.notes;
      return notes?.planner?.stage2?.model ?? '5-mini';
    } catch {
      return '5-mini';
    }
  })();

  const modelKey = PRICE_LOOKUP[modelKeyRaw] ? modelKeyRaw : '5-mini';
  const openaiModel = MODEL_ALIASES[modelKey] ?? MODEL_ALIASES['5-mini'];

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
      model: modelKey,
      message
    });
  }

  const results: Stage2Result[] = [];
  let processed = 0;
  let failures = 0;

  for (const item of items) {
    const ticker = item.ticker as string;
    const startedAt = new Date().toISOString();

    try {
      const meta = await fetchTickerMeta(supabaseAdmin, ticker);
      const sector = typeof meta?.sector === 'string' ? (meta.sector as string) : null;
      const sectorNotes = await fetchSectorNotes(supabaseAdmin, sector);
      const stage1Answer = await fetchStage1Answer(supabaseAdmin, runRow.id, ticker);

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

      const { parsed, usage } = await callOpenAI(openaiKey, openaiModel, ticker, meta, stage1Answer, sectorNotes);
      const { cost, promptTokens, completionTokens } = computeCost(modelKey, usage);
      const verdict = (parsed?.verdict ?? null) as JsonRecord | null;
      const goDeep = Boolean(verdict?.go_deep);

      await supabaseAdmin.from('answers').insert({
        run_id: runRow.id,
        ticker,
        stage: 2,
        question_group: 'medium',
        answer_json: parsed,
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

      await supabaseAdmin.from('cost_ledger').insert({
        run_id: runRow.id,
        stage: 2,
        model: modelKey,
        tokens_in: promptTokens,
        tokens_out: completionTokens,
        cost_usd: cost,
        created_at: startedAt
      });

      results.push({
        ticker,
        go_deep: goDeep,
        summary: extractSummary(parsed),
        updated_at: startedAt,
        status: 'ok'
      });
      processed += 1;
    } catch (error) {
      console.error(`Stage 2 processing failed for ${ticker}`, error);
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);

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
  const message = processed > 0
    ? `Processed ${processed} ticker${processed === 1 ? '' : 's'}. Pending survivors: ${metrics.pending}.`
    : 'No tickers processed.';

  return jsonResponse(200, {
    run_id: runRow.id,
    processed,
    failed: failures,
    metrics,
    results,
    model: modelKey,
    message
  });
});
