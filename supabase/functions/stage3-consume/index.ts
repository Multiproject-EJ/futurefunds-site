import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type JsonRecord = Record<string, unknown>;

type Stage3Result = {
  ticker: string;
  verdict: string | null;
  summary: string;
  updated_at: string;
  status: 'ok' | 'failed';
};

type Stage3Metrics = {
  finalists: number;
  pending: number;
  completed: number;
  failed: number;
  spend?: number;
};

type DocChunk = {
  source: string | null;
  chunk: string | null;
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

async function computeMetrics(client: ReturnType<typeof createClient>, runId: string): Promise<Stage3Metrics> {
  const { data, error } = await client.rpc('run_stage3_summary', { p_run_id: runId }).maybeSingle();
  if (error) throw error;
  return {
    finalists: Number(data?.total_finalists ?? data?.finalists ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0)
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

async function fetchStageAnswer(
  client: ReturnType<typeof createClient>,
  runId: string,
  ticker: string,
  stage: number
): Promise<JsonRecord | null> {
  const { data } = await client
    .from('answers')
    .select('answer_json')
    .eq('run_id', runId)
    .eq('ticker', ticker)
    .eq('stage', stage)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.answer_json ?? null) as JsonRecord | null;
}

async function fetchDocChunks(client: ReturnType<typeof createClient>, ticker: string, limit = 6) {
  const { data, error } = await client
    .from('doc_chunks')
    .select('source, chunk')
    .eq('ticker', ticker)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as DocChunk[];
}

function formatStage1Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 1 output unavailable.';
  const label = answer.label ?? answer.classification;
  const reasons = Array.isArray(answer.reasons) ? answer.reasons : [];
  const formattedReasons = reasons
    .slice(0, 4)
    .map((reason: unknown, index: number) => `${index + 1}. ${String(reason)}`)
    .join('\n');
  return `Stage 1 label: ${label ?? 'n/a'}\n${formattedReasons ? `Key reasons:\n${formattedReasons}` : ''}`.trim();
}

function formatStage2Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 2 verdict unavailable.';
  const verdict = (answer.verdict as JsonRecord | undefined) ?? {};
  const scores = (answer.scores as JsonRecord | undefined) ?? {};
  const lines: string[] = [];
  if (typeof verdict.summary === 'string' && verdict.summary.trim()) {
    lines.push(`Verdict: ${verdict.summary.trim()}`);
  }
  if (typeof verdict.go_deep !== 'undefined') {
    const goDeep = typeof verdict.go_deep === 'boolean' ? verdict.go_deep : String(verdict.go_deep).toLowerCase() === 'true';
    lines.push(`Go deep: ${goDeep ? 'yes' : 'no'}`);
  }
  for (const [key, value] of Object.entries(scores)) {
    if (!value || typeof value !== 'object') continue;
    const score = (value as JsonRecord).score;
    const rationale = (value as JsonRecord).rationale;
    if (typeof score !== 'undefined' || typeof rationale === 'string') {
      lines.push(`${key}: ${typeof score === 'number' ? `${score}/10` : 'n/a'} – ${rationale ?? 'n/a'}`);
    }
  }
  return lines.length ? lines.join('\n') : 'Stage 2 scores unavailable.';
}

function formatDocSnippets(chunks: DocChunk[]) {
  if (!chunks.length) return 'No external excerpts supplied.';
  return chunks
    .map((chunk, index) => {
      const source = chunk.source ? String(chunk.source) : 'Unknown source';
      const text = (chunk.chunk ?? '').toString().slice(0, 800);
      return `Snippet ${index + 1} — ${source}:\n${text}`;
    })
    .join('\n---\n');
}

function buildGroupPrompts(context: {
  ticker: string;
  meta: Record<string, unknown>;
  stage1: string;
  stage2: string;
  docs: string;
}) {
  const header = [
    `Ticker: ${context.ticker}`,
    `Name: ${context.meta.name ?? 'Unknown'}`,
    `Exchange: ${context.meta.exchange ?? 'n/a'}`,
    `Country: ${context.meta.country ?? 'n/a'}`,
    `Sector: ${context.meta.sector ?? 'n/a'}`,
    `Industry: ${context.meta.industry ?? 'n/a'}`,
    '',
    context.stage1,
    '',
    context.stage2,
    '',
    `Document excerpts:`,
    context.docs
  ].join('\n');

  return [
    {
      key: 'business',
      system:
        'You are a buy-side equity analyst. Return strict JSON matching {"business_model": string, "moat": {"score": int, "rationale": string}, "customer_lock_in": string, "growth_drivers": [string]}.' +
        ' Scores must be 0-10. Keep rationales under 160 characters and ground commentary in supplied facts.',
      user: `${header}\n\nFocus: describe the business model, moat durability, customer lock-in dynamics, and near-term growth drivers.`
    },
    {
      key: 'financials',
      system:
        'You are evaluating unit economics and capital allocation. Return JSON {"unit_economics": {"score": int, "rationale": string}, "capital_allocation": {"score": int, "rationale": string}, "balance_sheet": {"score": int, "rationale": string}, "kpis": [string]}.' +
        ' Scores must be 0-10. Summaries must be concise and factual.',
      user: `${header}\n\nFocus: comment on unit economics resilience, capital allocation discipline, balance sheet flexibility, and standout KPIs.`
    },
    {
      key: 'risks',
      system:
        'You are cataloguing risk and timing. Return JSON {"principal_risks": [string], "catalysts": [string], "timing_window": string, "monitoring_flags": [string]}.' +
        ' Keep lists to a maximum of 5 items and ensure each item is specific.',
      user: `${header}\n\nFocus: enumerate principal risks, catalysts, the likely timing window (e.g., 3-6 months) and monitoring flags for follow-up.`
    }
  ];
}

function buildSummaryPrompt(
  context: { ticker: string; meta: Record<string, unknown>; stage1: string; stage2: string; docs: string },
  groupOutputs: JsonRecord[]
) {
  const base = [
    `Ticker: ${context.ticker}`,
    `Name: ${context.meta.name ?? 'Unknown'}`,
    '',
    context.stage1,
    '',
    context.stage2,
    '',
    'Deep dive findings:',
    JSON.stringify(groupOutputs)
  ].join('\n');

  return {
    system:
      'You are preparing an investment memo. Return JSON {"verdict": string, "confidence": int, "thesis": string, "watch_items": [string], "next_actions": [string]}.' +
      ' Confidence must be 0-100. Thesis should be < 200 words and evidence-backed. Watch items/next actions max 5 each.',
    user: `${base}\n\nCompose the final verdict, conviction score, thesis paragraph, key watch items, and next actions.`
  };
}

async function callOpenAIJson(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ parsed: JsonRecord; usage: { prompt_tokens?: number; completion_tokens?: number } }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
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
    throw new Error(`Failed to parse OpenAI JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { parsed, usage: payload?.usage ?? { prompt_tokens: 0, completion_tokens: 0 } };
}

function computeCost(modelKey: string, usage: { prompt_tokens?: number; completion_tokens?: number }) {
  const price = PRICE_LOOKUP[modelKey] ?? PRICE_LOOKUP['5'];
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
    console.error('Missing required environment configuration for stage3-consume');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const limit = clamp(asNumber(payload?.limit, 2), 1, 6);
  const requestedRunId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  const runId = isUuid(requestedRunId) ? requestedRunId : null;
  if (!runId) {
    return jsonResponse(400, { error: 'Invalid or missing run_id' });
  }

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

  const isAdmin = isAdminContext({
    user: userData.user,
    profile: profileResult.data ?? null,
    membership: membershipResult.data ?? null
  });

  if (!isAdmin) {
    return jsonResponse(403, { error: 'Admin privileges required' });
  }

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .select('id, status, stop_requested, notes')
    .eq('id', runId)
    .maybeSingle();

  if (runError) {
    console.error('Failed to load run', runError);
    return jsonResponse(500, { error: 'Failed to load run' });
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
      return notes?.planner?.stage3?.model ?? '5';
    } catch {
      return '5';
    }
  })();

  const modelKey = PRICE_LOOKUP[modelKeyRaw] ? modelKeyRaw : '5';
  const openaiModel = MODEL_ALIASES[modelKey] ?? MODEL_ALIASES['5'];

  const { data: pending, error: pendingError } = await supabaseAdmin
    .from('run_items')
    .select('ticker, stage, status, spend_est_usd')
    .eq('run_id', runRow.id)
    .eq('status', 'ok')
    .eq('stage2_go_deep', true)
    .lt('stage', 3)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (pendingError) {
    console.error('Failed to load Stage 3 finalists', pendingError);
    return jsonResponse(500, { error: 'Failed to load Stage 3 finalists', details: pendingError.message });
  }

  const items = pending ?? [];
  if (!items.length) {
    const metrics = await computeMetrics(supabaseAdmin, runRow.id);
    const message = metrics.pending === 0
      ? 'Stage 3 complete or no finalists marked go-deep.'
      : 'No eligible Stage 3 finalists pending.';
    return jsonResponse(200, {
      run_id: runRow.id,
      processed: 0,
      failed: 0,
      model: modelKey,
      metrics,
      results: [],
      message
    });
  }

  const results: Stage3Result[] = [];
  let processed = 0;
  let failures = 0;

  for (const item of items) {
    const ticker = item.ticker;
    const startedAt = new Date().toISOString();

    try {
      const [meta, stage1Answer, stage2Answer, docChunks] = await Promise.all([
        fetchTickerMeta(supabaseAdmin, ticker),
        fetchStageAnswer(supabaseAdmin, runRow.id, ticker, 1),
        fetchStageAnswer(supabaseAdmin, runRow.id, ticker, 2),
        fetchDocChunks(supabaseAdmin, ticker)
      ]);

      const context = {
        ticker,
        meta,
        stage1: formatStage1Summary(stage1Answer),
        stage2: formatStage2Summary(stage2Answer),
        docs: formatDocSnippets(docChunks)
      };

      const prompts = buildGroupPrompts(context);
      const groupOutputs: JsonRecord[] = [];
      let totalCost = 0;

      for (const prompt of prompts) {
        const { parsed, usage } = await callOpenAIJson(openaiKey, openaiModel, prompt.system, prompt.user);
        const { cost, promptTokens, completionTokens } = computeCost(modelKey, usage);
        totalCost += cost;

        await supabaseAdmin.from('answers').insert({
          run_id: runRow.id,
          ticker,
          stage: 3,
          question_group: prompt.key,
          answer_json: parsed,
          tokens_in: promptTokens,
          tokens_out: completionTokens,
          cost_usd: cost,
          created_at: startedAt
        });

        await supabaseAdmin.from('cost_ledger').insert({
          run_id: runRow.id,
          stage: 3,
          model: modelKey,
          tokens_in: promptTokens,
          tokens_out: completionTokens,
          cost_usd: cost,
          created_at: startedAt
        });

        groupOutputs.push({ key: prompt.key, data: parsed });
      }

      const summaryPrompt = buildSummaryPrompt(context, groupOutputs);
      const { parsed: summaryJson, usage: summaryUsage } = await callOpenAIJson(
        openaiKey,
        openaiModel,
        summaryPrompt.system,
        summaryPrompt.user
      );
      const { cost: summaryCost, promptTokens: summaryPromptTokens, completionTokens: summaryCompletionTokens } = computeCost(
        modelKey,
        summaryUsage
      );
      totalCost += summaryCost;

      const thesisText =
        typeof summaryJson.thesis === 'string'
          ? summaryJson.thesis
          : typeof summaryJson.narrative === 'string'
            ? summaryJson.narrative
            : null;

      await supabaseAdmin.from('answers').insert({
        run_id: runRow.id,
        ticker,
        stage: 3,
        question_group: 'summary',
        answer_json: summaryJson,
        answer_text: thesisText,
        tokens_in: summaryPromptTokens,
        tokens_out: summaryCompletionTokens,
        cost_usd: summaryCost,
        created_at: startedAt
      });

      await supabaseAdmin.from('cost_ledger').insert({
        run_id: runRow.id,
        stage: 3,
        model: modelKey,
        tokens_in: summaryPromptTokens,
        tokens_out: summaryCompletionTokens,
        cost_usd: summaryCost,
        created_at: startedAt
      });

      await supabaseAdmin
        .from('run_items')
        .update({
          stage: 3,
          status: 'ok',
          spend_est_usd: Number(item.spend_est_usd ?? 0) + totalCost,
          updated_at: new Date().toISOString()
        })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      results.push({
        ticker,
        verdict: typeof summaryJson.verdict === 'string' ? summaryJson.verdict : summaryJson.rating?.toString() ?? null,
        summary: thesisText ?? (typeof summaryJson.summary === 'string' ? summaryJson.summary : '—'),
        updated_at: startedAt,
        status: 'ok'
      });
      processed += 1;
    } catch (error) {
      console.error(`Stage 3 processing failed for ${ticker}`, error);
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);

      await supabaseAdmin
        .from('run_items')
        .update({ stage: 3, status: 'failed', updated_at: new Date().toISOString() })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      results.push({
        ticker,
        verdict: null,
        summary: message,
        updated_at: new Date().toISOString(),
        status: 'failed'
      });
    }
  }

  const metrics = await computeMetrics(supabaseAdmin, runRow.id);
  let spend = 0;
  try {
    const { data: breakdown } = await supabaseAdmin.rpc('run_cost_breakdown', { p_run_id: runRow.id });
    if (Array.isArray(breakdown)) {
      spend = breakdown
        .filter((row: any) => Number(row.stage) === 3)
        .reduce((acc: number, row: any) => acc + Number(row.cost_usd ?? 0), 0);
    }
  } catch (error) {
    console.error('Failed to compute Stage 3 spend', error);
  }
  const metricsWithSpend: Stage3Metrics = { ...metrics, spend };

  const message = processed > 0
    ? `Processed ${processed} finalist${processed === 1 ? '' : 's'}. Pending deep dives: ${metrics.pending}.`
    : 'No finalists processed.';

  return jsonResponse(200, {
    run_id: runRow.id,
    processed,
    failed: failures,
    model: modelKey,
    metrics: metricsWithSpend,
    results,
    message
  });
});
