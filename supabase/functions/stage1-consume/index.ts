import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  resolveModel,
  resolveCredential,
  computeUsageCost,
  requestChatCompletion,
  withRetry
} from '../_shared/ai.ts';
import { validateStage1Response, explainValidation } from '../_shared/prompt-validators.ts';
import { recordErrorLog } from '../_shared/observability.ts';
import {
  applyRequestSettings,
  getStageConfig,
  unpackRetrySettings
} from '../_shared/model-config.ts';
import { loadPromptTemplate, renderTemplate } from '../_shared/prompt-loader.ts';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

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

const stageDefaults = getStageConfig('stage1');
const DEFAULT_STAGE1_MODEL = stageDefaults?.default_model ?? 'openrouter/gpt-4o-mini';
const FALLBACK_STAGE1_MODEL = stageDefaults?.fallback_model ?? 'openai/gpt-4o-mini';
const stageRequestSettings = stageDefaults?.request ?? null;
const stageRetry = unpackRetrySettings(stageDefaults?.retry);

const systemPromptTemplate = loadPromptTemplate('stage1/system');
const userPromptTemplate = loadPromptTemplate('stage1/user');

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

async function buildUserPrompt(ticker: string, meta: Record<string, unknown>) {
  const template = await userPromptTemplate;
  return renderTemplate(template, {
    ticker,
    name: String(meta.name ?? 'Unknown'),
    exchange: String(meta.exchange ?? 'n/a'),
    country: String(meta.country ?? 'n/a'),
    sector: String(meta.sector ?? 'n/a'),
    industry: String(meta.industry ?? 'n/a')
  });
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
  const stageConfig = extractStageConfig(plannerNotes, 'stage1');

  let modelRecord;
  const desiredModel = stageConfig.model?.trim() || DEFAULT_STAGE1_MODEL;
  try {
    modelRecord = await resolveModel(supabaseAdmin, desiredModel, FALLBACK_STAGE1_MODEL);
  } catch (error) {
    console.error('Stage 1 model configuration error', error);
    return jsonResponse(500, {
      error: 'Stage 1 model not configured',
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
    console.error('Stage 1 credential configuration error', error);
    return jsonResponse(500, {
      error: 'Stage 1 credential not configured',
      details: error instanceof Error ? error.message : String(error)
    });
  }

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
    let rawMessage = '{}';
    let parsed: JsonRecord = {};

    try {
      const meta = await fetchTickerMeta(supabaseAdmin, ticker);
      const [systemPrompt, userPrompt] = await Promise.all([
        systemPromptTemplate,
        buildUserPrompt(ticker, meta)
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
      const completion = await withRetry(
        stageRetry.attempts,
        stageRetry.backoffMs,
        () => requestChatCompletion(modelRecord, credentialRecord, requestBody),
        { jitter: stageRetry.jitter }
      );

      rawMessage = completion?.choices?.[0]?.message?.content ?? '{}';
      try {
        parsed = JSON.parse(rawMessage);
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : String(error);
        const parseError = new Error(`Failed to parse model response JSON: ${parseMessage}`);
        (parseError as Error & { logPayload?: JsonRecord }).logPayload = {
          raw_response: rawMessage,
          parse_error: parseMessage
        };
        throw parseError;
      }

      const validation = validateStage1Response(parsed);
      if (!validation.valid) {
        const validationError = new Error(
          `Stage 1 schema validation failed: ${explainValidation(validation)}`
        );
        (validationError as Error & { logPayload?: JsonRecord }).logPayload = {
          raw_response: rawMessage,
          validation_errors: validation.errors,
          parsed
        };
        throw validationError;
      }

      const usage = completion?.usage ?? {};
      const { cost, promptTokens, completionTokens } = computeUsageCost(modelRecord, usage);

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
          stage2_go_deep: null,
          spend_est_usd: Number(item.spend_est_usd ?? 0) + cost,
          updated_at: new Date().toISOString()
        })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      await supabaseAdmin.from('cost_ledger').insert({
        run_id: runRow.id,
        stage: 1,
        model: modelRecord.slug,
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

      const basePayload: JsonRecord =
        error && typeof (error as { logPayload?: JsonRecord }).logPayload === 'object'
          ? { ...(error as { logPayload?: JsonRecord }).logPayload }
          : {};
      if (!basePayload.raw_response) {
        basePayload.raw_response = rawMessage;
      }
      basePayload.error_message = message;
      basePayload.ticker = ticker;

      await recordErrorLog(supabaseAdmin, {
        context: 'stage1-consume',
        message,
        runId: runRow.id,
        ticker,
        stage: 1,
        promptId: 'stage1-triage',
        payload: {
          ...basePayload,
          run_item: {
            status: item.status,
            stage: item.stage,
            spend_est_usd: item.spend_est_usd
          }
        },
        metadata: {
          planner_model: stageConfig.model,
          planner_credential: stageConfig.credentialId
        }
      });

      results.push({
        ticker,
        label: null,
        summary: message,
        updated_at: startedAt,
        status: 'failed'
      });

      await supabaseAdmin
        .from('run_items')
        .update({ status: 'failed', stage2_go_deep: null, updated_at: new Date().toISOString() })
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
    model: modelRecord.slug,
    message
  });
});
