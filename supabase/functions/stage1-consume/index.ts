import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type JsonRecord = Record<string, unknown>;

type Metrics = {
  total: number;
  pending: number;
  completed: number;
  failed: number;
};

type StageResult = {
  ticker: string;
  label: string | null;
  summary: string;
  updated_at: string;
  status: 'ok' | 'failed';
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

const SYSTEM_PROMPT = `You are a buy-side screening analyst. Classify each ticker as one of "uninvestible", "borderline", or "consider". ` +
  `Return strict JSON with the shape {"label": "uninvestible|borderline|consider", "reasons": [short bullet strings], "flags": {"leverage": string, "governance": string, "dilution": string}}. ` +
  `Be decisive, grounded in fundamentals, and keep reasons concise.`;

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

async function computeMetrics(client: ReturnType<typeof createClient>, runId: string): Promise<Metrics> {
  const [totalRes, pendingRes, completedRes, failedRes] = await Promise.all([
    client.from('run_items').select('*', { count: 'exact', head: true }).eq('run_id', runId),
    client
      .from('run_items')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', runId)
      .eq('status', 'pending')
      .eq('stage', 0),
    client
      .from('run_items')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', runId)
      .eq('status', 'ok')
      .gte('stage', 1),
    client
      .from('run_items')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', runId)
      .eq('status', 'failed')
  ]);

  if (totalRes.error) throw totalRes.error;
  if (pendingRes.error) throw pendingRes.error;
  if (completedRes.error) throw completedRes.error;
  if (failedRes.error) throw failedRes.error;

  return {
    total: totalRes.count ?? 0,
    pending: pendingRes.count ?? 0,
    completed: completedRes.count ?? 0,
    failed: failedRes.count ?? 0
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

function buildUserPrompt(ticker: string, meta: Record<string, unknown>) {
  const parts = [
    `Ticker: ${ticker}`,
    `Name: ${meta.name ?? 'Unknown'}`,
    `Exchange: ${meta.exchange ?? 'n/a'}`,
    `Country: ${meta.country ?? 'n/a'}`,
    `Sector: ${meta.sector ?? 'n/a'}`,
    `Industry: ${meta.industry ?? 'n/a'}`
  ];
  return parts.join('\n');
}

async function callOpenAI(apiKey: string, model: string, ticker: string, meta: Record<string, unknown>) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(ticker, meta) }
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
  const price = PRICE_LOOKUP[modelKey] ?? PRICE_LOOKUP['4o-mini'];
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
    console.error('Missing required environment configuration for stage1-consume');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const limit = clamp(asNumber(payload?.limit, 8), 1, 25);
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
      return notes?.planner?.stage1?.model ?? '4o-mini';
    } catch {
      return '4o-mini';
    }
  })();

  const modelKey = PRICE_LOOKUP[modelKeyRaw] ? modelKeyRaw : '4o-mini';
  const openaiModel = MODEL_ALIASES[modelKey] ?? MODEL_ALIASES['4o-mini'];

  const { data: pending, error: pendingError } = await supabaseAdmin
    .from('run_items')
    .select('ticker, spend_est_usd')
    .eq('run_id', runRow.id)
    .eq('status', 'pending')
    .eq('stage', 0)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (pendingError) {
    console.error('Failed to load pending run items', pendingError);
    return jsonResponse(500, { error: 'Failed to load pending run items', details: pendingError.message });
  }

  const items = pending ?? [];
  if (items.length === 0) {
    const metrics = await computeMetrics(supabaseAdmin, runRow.id);
    const message = metrics.pending === 0
      ? 'Stage 1 complete for this run.'
      : 'No pending items available for Stage 1.';
    return jsonResponse(200, {
      run_id: runRow.id,
      processed: 0,
      failed: 0,
      metrics,
      results: [],
      message
    });
  }

  const results: StageResult[] = [];
  let processed = 0;
  let failures = 0;

  for (const item of items) {
    const ticker = item.ticker as string;
    const startedAt = new Date().toISOString();
    try {
      const meta = await fetchTickerMeta(supabaseAdmin, ticker);
      const { parsed, usage } = await callOpenAI(openaiKey, openaiModel, ticker, meta);
      const { cost, promptTokens, completionTokens } = computeCost(modelKey, usage);

      await supabaseAdmin.from('answers').insert({
        run_id: runRow.id,
        ticker,
        stage: 1,
        question_group: 'triage',
        answer_json: parsed,
        tokens_in: promptTokens,
        tokens_out: completionTokens,
        cost_usd: cost,
        created_at: startedAt
      });

      await supabaseAdmin
        .from('run_items')
        .update({
          stage: 1,
          status: 'ok',
          label: typeof parsed?.label === 'string' ? parsed.label : null,
          spend_est_usd: Number(item.spend_est_usd ?? 0) + cost,
          updated_at: new Date().toISOString()
        })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      await supabaseAdmin.from('cost_ledger').insert({
        run_id: runRow.id,
        stage: 1,
        model: modelKey,
        tokens_in: promptTokens,
        tokens_out: completionTokens,
        cost_usd: cost,
        created_at: startedAt
      });

      const summary = Array.isArray(parsed?.reasons) && parsed.reasons.length
        ? String(parsed.reasons[0])
        : typeof parsed?.summary === 'string'
          ? parsed.summary
          : typeof parsed?.reason === 'string'
            ? parsed.reason
            : '—';

      results.push({
        ticker,
        label: typeof parsed?.label === 'string' ? parsed.label : null,
        summary,
        updated_at: startedAt,
        status: 'ok'
      });
      processed += 1;
    } catch (error) {
      console.error(`Stage 1 processing failed for ${ticker}`, error);
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ticker,
        label: null,
        summary: message,
        updated_at: startedAt,
        status: 'failed'
      });

      await supabaseAdmin
        .from('run_items')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);
    }
  }

  const metrics = await computeMetrics(supabaseAdmin, runRow.id);
  const message = processed > 0
    ? `Processed ${processed} ticker${processed === 1 ? '' : 's'}. Pending: ${metrics.pending}.`
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
