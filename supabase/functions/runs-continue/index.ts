import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

type JsonRecord = Record<string, unknown>;

type Stage1Metrics = {
  total: number;
  pending: number;
  completed: number;
  failed: number;
};

type Stage2Summary = {
  total_survivors: number;
  pending: number;
  completed: number;
  failed: number;
  go_deep: number;
};

type Stage3Summary = {
  total_finalists: number;
  pending: number;
  completed: number;
  failed: number;
};

type FocusSummary = {
  total_requests: number;
  pending: number;
  completed: number;
  failed: number;
};

type StageOperation = {
  stage: 1 | 2 | 3 | 4;
  status: 'invoked' | 'halted';
  processed: number;
  failed: number;
  message: string;
  metrics: JsonRecord | null;
  http_status: number;
};

type InvokeOutcome =
  | { type: 'ok'; operation: StageOperation; metrics: JsonRecord | null }
  | { type: 'halt'; operation: StageOperation; metrics: JsonRecord | null; reason: 'stop_requested' }
  | { type: 'error'; status: number; message: string; details?: JsonRecord | null };

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

const DEFAULT_STAGE_LIMITS = { stage1: 8, stage2: 4, stage3: 2, focus: 3 } as const;
const MAX_STAGE_LIMIT = 25;
const MAX_CYCLES = 10;

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  if (Number.isNaN(rounded)) return fallback;
  return Math.min(Math.max(rounded, min), max);
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

async function computeStage1Metrics(client: ReturnType<typeof createClient>, runId: string): Promise<Stage1Metrics> {
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

async function fetchStage2Summary(client: ReturnType<typeof createClient>, runId: string): Promise<Stage2Summary> {
  const { data, error } = await client.rpc('run_stage2_summary', { p_run_id: runId }).maybeSingle();
  if (error) {
    console.error('run_stage2_summary failed', error);
    return { total_survivors: 0, pending: 0, completed: 0, failed: 0, go_deep: 0 };
  }

  return {
    total_survivors: Number(data?.total_survivors ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0),
    go_deep: Number(data?.go_deep ?? 0)
  };
}

async function fetchStage3Summary(client: ReturnType<typeof createClient>, runId: string): Promise<Stage3Summary> {
  const { data, error } = await client.rpc('run_stage3_summary', { p_run_id: runId }).maybeSingle();
  if (error) {
    console.error('run_stage3_summary failed', error);
    return { total_finalists: 0, pending: 0, completed: 0, failed: 0 };
  }

  return {
    total_finalists: Number(data?.total_finalists ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0)
  };
}

async function fetchFocusSummary(client: ReturnType<typeof createClient>, runId: string): Promise<FocusSummary> {
  const { data, error } = await client.rpc('run_focus_summary', { p_run_id: runId }).maybeSingle();
  if (error) {
    console.error('run_focus_summary failed', error);
    return { total_requests: 0, pending: 0, completed: 0, failed: 0 };
  }

  return {
    total_requests: Number(data?.total_requests ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0)
  };
}

async function fetchCostSummary(client: ReturnType<typeof createClient>, runId: string) {
  const { data, error } = await client.rpc('run_cost_summary', { p_run_id: runId }).maybeSingle();
  if (error) {
    console.error('run_cost_summary failed', error);
    return { totalCost: 0, totalTokensIn: 0, totalTokensOut: 0 };
  }

  return {
    totalCost: Number(data?.total_cost ?? 0),
    totalTokensIn: Number(data?.total_tokens_in ?? 0),
    totalTokensOut: Number(data?.total_tokens_out ?? 0)
  };
}

function mergeClientMeta(base: Record<string, unknown> | null | undefined, additions: Record<string, unknown>) {
  if (!base || typeof base !== 'object') {
    return additions;
  }
  try {
    return { ...base, ...additions };
  } catch (_error) {
    return additions;
  }
}

async function invokeStage({
  stage,
  limit,
  runId,
  functionsBaseUrl,
  cycleIndex,
  clientMeta,
  mode,
  accessToken,
  serviceSecret
}: {
  stage: 1 | 2 | 3 | 4;
  limit: number;
  runId: string;
  functionsBaseUrl: string;
  cycleIndex: number;
  clientMeta: Record<string, unknown> | null | undefined;
  mode: 'user' | 'service';
  accessToken?: string | null;
  serviceSecret?: string | null;
}): Promise<InvokeOutcome> {
  const endpoint =
    stage === 1
      ? `${functionsBaseUrl}/stage1-consume`
      : stage === 2
        ? `${functionsBaseUrl}/stage2-consume`
        : stage === 3
          ? `${functionsBaseUrl}/stage3-consume`
          : `${functionsBaseUrl}/focus-consume`;

  const meta = mergeClientMeta(clientMeta, {
    orchestrator: 'runs-continue',
    cycle_index: cycleIndex,
    triggered_at: new Date().toISOString(),
    invocation_mode: mode
  });

  let response: Response;
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (mode === 'service') {
      if (!serviceSecret) {
        return {
          type: 'error',
          status: 500,
          message: 'Automation secret missing for service invocation'
        };
      }
      headers.set('x-automation-secret', serviceSecret);
    } else if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    } else {
      return {
        type: 'error',
        status: 401,
        message: 'Missing access token for stage invocation'
      };
    }

    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        run_id: runId,
        limit,
        client_meta: meta
      })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error invoking stage';
    return { type: 'error', status: 502, message };
  }

  let payload: JsonRecord | null = null;
  try {
    const raw = await response.text();
    payload = raw ? (JSON.parse(raw) as JsonRecord) : {};
  } catch (error) {
    console.warn(`Failed to parse JSON from stage${stage}-consume`, error);
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload?.error && typeof payload.error === 'string')
        ? payload.error
        : `Stage ${stage} responded with status ${response.status}`;

    if (response.status === 409) {
      const operation: StageOperation = {
        stage,
        status: 'halted',
        processed: Number(payload?.processed ?? 0),
        failed: Number(payload?.failed ?? 0),
        message,
        metrics: (payload?.metrics as JsonRecord) ?? null,
        http_status: response.status
      };
      return { type: 'halt', operation, metrics: operation.metrics, reason: 'stop_requested' };
    }

    return { type: 'error', status: response.status, message, details: payload };
  }

  const operation: StageOperation = {
    stage,
    status: 'invoked',
    processed: Number(payload?.processed ?? 0),
    failed: Number(payload?.failed ?? 0),
    message: typeof payload?.message === 'string' ? (payload.message as string) : 'Stage completed.',
    metrics: (payload?.metrics as JsonRecord) ?? null,
    http_status: response.status
  };

  return { type: 'ok', operation, metrics: operation.metrics };
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
    console.error('Missing Supabase configuration for runs-continue');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload for runs-continue', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const requestedRunId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  const runIdInput = isUuid(requestedRunId) ? requestedRunId : null;

  const limitPayload = payload?.stage_limits ?? {};
  const stageLimits = {
    stage1: clampInteger(limitPayload?.stage1 ?? payload?.stage1_limit ?? payload?.limit, 1, MAX_STAGE_LIMIT, DEFAULT_STAGE_LIMITS.stage1),
    stage2: clampInteger(limitPayload?.stage2 ?? payload?.stage2_limit ?? payload?.limit, 1, MAX_STAGE_LIMIT, DEFAULT_STAGE_LIMITS.stage2),
    stage3: clampInteger(limitPayload?.stage3 ?? payload?.stage3_limit ?? payload?.limit, 1, MAX_STAGE_LIMIT, DEFAULT_STAGE_LIMITS.stage3),
    focus: clampInteger(
      limitPayload?.focus ?? payload?.focus_limit ?? payload?.stage4_limit ?? payload?.limit,
      1,
      MAX_STAGE_LIMIT,
      DEFAULT_STAGE_LIMITS.focus
    )
  };

  const cycles = clampInteger(payload?.cycles, 1, MAX_CYCLES, 1);

  const serviceAuth = resolveServiceAuth(req);
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let invocationMode: 'user' | 'service' = 'user';
  let accessToken: string | null = null;
  let serviceSecret: string | null = null;

  if (serviceAuth.authorized) {
    invocationMode = 'service';
    serviceSecret = serviceAuth.providedSecret;
  } else {
    const authHeader = req.headers.get('Authorization') ?? '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    accessToken = tokenMatch?.[1]?.trim() ?? null;

    if (!accessToken) {
      return jsonResponse(401, { error: 'Missing bearer token' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.error('Invalid session token for runs-continue', userError);
      return jsonResponse(401, { error: 'Invalid or expired session token' });
    }

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
      supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
    ]);

    if (profileResult.error) {
      console.warn('Failed to load profile for runs-continue', profileResult.error);
    }
    if (membershipResult.error) {
      console.warn('Failed to load membership for runs-continue', membershipResult.error);
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

  const runColumns = 'id, status, stop_requested, notes, budget_usd';

  let runRow: Record<string, unknown> | null = null;
  let runError: Error | null = null;

  if (runIdInput) {
    const { data, error } = await supabaseAdmin.from('runs').select(runColumns).eq('id', runIdInput).maybeSingle();
    if (error && error.message?.toLowerCase().includes('budget_usd')) {
      const fallback = await supabaseAdmin
        .from('runs')
        .select('id, status, stop_requested, notes')
        .eq('id', runIdInput)
        .maybeSingle();
      runRow = fallback.data ?? null;
      runError = fallback.error ?? null;
    } else {
      runRow = data ?? null;
      runError = error;
    }
  } else {
    const { data, error } = await supabaseAdmin
      .from('runs')
      .select(runColumns)
      .in('status', ['running', 'queued'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.message?.toLowerCase().includes('budget_usd')) {
      const fallback = await supabaseAdmin
        .from('runs')
        .select('id, status, stop_requested, notes')
        .in('status', ['running', 'queued'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      runRow = fallback.data ?? null;
      runError = fallback.error ?? null;
    } else {
      runRow = data ?? null;
      runError = error;
    }
  }

  if (runError) {
    console.error('Failed to load run for runs-continue', runError);
    return jsonResponse(500, { error: 'Failed to load run', details: runError.message });
  }

  if (!runRow) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  const runId = String(runRow.id);
  const runStatus = typeof runRow.status === 'string' ? (runRow.status as string) : null;

  const budgetValue = Number(runRow?.budget_usd ?? NaN);
  const budgetConfigured = Number.isFinite(budgetValue) && budgetValue > 0;

  const initialCost = await fetchCostSummary(supabaseAdmin, runId);
  let totalCost = initialCost.totalCost;

  const budgetExceededInitially = budgetConfigured && totalCost >= budgetValue - 0.0005;

  let stopRequested = Boolean(runRow?.stop_requested ?? false);
  let haltedReason: 'stop_requested' | 'budget_exhausted' | null = null;

  if (stopRequested) {
    haltedReason = 'stop_requested';
  } else if (budgetExceededInitially) {
    haltedReason = 'budget_exhausted';
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('runs')
      .update({ stop_requested: true })
      .eq('id', runId)
      .select('stop_requested')
      .maybeSingle();
    if (updateError) {
      console.warn('Failed to set stop_requested after budget exhaustion', updateError);
    } else if (updated) {
      stopRequested = Boolean(updated.stop_requested);
    }
  }

  const functionsBaseUrl = supabaseUrl.replace(/\.supabase\.co$/, '.functions.supabase.co');

  let stage1Metrics = await computeStage1Metrics(supabaseAdmin, runId);
  let stage2Summary = await fetchStage2Summary(supabaseAdmin, runId);
  let stage3Summary = await fetchStage3Summary(supabaseAdmin, runId);
  let focusSummary = await fetchFocusSummary(supabaseAdmin, runId);

  const operations: StageOperation[] = [];
  let cyclesCompleted = 0;

  if (!haltedReason) {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      let cycleDidWork = false;

      if (stage1Metrics.pending > 0) {
        const outcome = await invokeStage({
          stage: 1,
          limit: stageLimits.stage1,
          runId,
          functionsBaseUrl,
          cycleIndex: cycle,
          clientMeta: payload?.client_meta,
          mode: invocationMode,
          accessToken,
          serviceSecret
        });

        if (outcome.type === 'error') {
          return jsonResponse(outcome.status, {
            error: outcome.message,
            details: outcome.details ?? null,
            operations,
            stage_status: {
              stage1: stage1Metrics,
              stage2: stage2Summary,
              stage3: stage3Summary,
              focus: focusSummary
            }
          });
        }

        operations.push(outcome.operation);
        stage1Metrics = await computeStage1Metrics(supabaseAdmin, runId);
        stage2Summary = await fetchStage2Summary(supabaseAdmin, runId);
        cycleDidWork = true;

        if (outcome.type === 'halt') {
          haltedReason = outcome.reason;
          break;
        }
      }

      if (haltedReason) break;

      if (stage2Summary.pending > 0) {
        const outcome = await invokeStage({
          stage: 2,
          limit: stageLimits.stage2,
          runId,
          functionsBaseUrl,
          cycleIndex: cycle,
          clientMeta: payload?.client_meta,
          mode: invocationMode,
          accessToken,
          serviceSecret
        });

        if (outcome.type === 'error') {
          return jsonResponse(outcome.status, {
            error: outcome.message,
            details: outcome.details ?? null,
            operations,
            stage_status: {
              stage1: stage1Metrics,
              stage2: stage2Summary,
              stage3: stage3Summary,
              focus: focusSummary
            }
          });
        }

        operations.push(outcome.operation);
        stage2Summary = await fetchStage2Summary(supabaseAdmin, runId);
        stage3Summary = await fetchStage3Summary(supabaseAdmin, runId);
        focusSummary = await fetchFocusSummary(supabaseAdmin, runId);
        cycleDidWork = true;

        if (outcome.type === 'halt') {
          haltedReason = outcome.reason;
          break;
        }
      }

      if (haltedReason) break;

      if (stage3Summary.pending > 0) {
        const outcome = await invokeStage({
          stage: 3,
          limit: stageLimits.stage3,
          runId,
          functionsBaseUrl,
          cycleIndex: cycle,
          clientMeta: payload?.client_meta,
          mode: invocationMode,
          accessToken,
          serviceSecret
        });

        if (outcome.type === 'error') {
          return jsonResponse(outcome.status, {
            error: outcome.message,
            details: outcome.details ?? null,
            operations,
            stage_status: {
              stage1: stage1Metrics,
              stage2: stage2Summary,
              stage3: stage3Summary,
              focus: focusSummary
            }
          });
        }

        operations.push(outcome.operation);
        stage3Summary = await fetchStage3Summary(supabaseAdmin, runId);
        focusSummary = await fetchFocusSummary(supabaseAdmin, runId);
        cycleDidWork = true;

        if (outcome.type === 'halt') {
          haltedReason = outcome.reason;
          break;
        }
      }

      if (haltedReason) break;

      if (focusSummary.pending > 0) {
        const outcome = await invokeStage({
          stage: 4,
          limit: stageLimits.focus,
          runId,
          functionsBaseUrl,
          cycleIndex: cycle,
          clientMeta: payload?.client_meta,
          mode: invocationMode,
          accessToken,
          serviceSecret
        });

        if (outcome.type === 'error') {
          return jsonResponse(outcome.status, {
            error: outcome.message,
            details: outcome.details ?? null,
            operations,
            stage_status: {
              stage1: stage1Metrics,
              stage2: stage2Summary,
              stage3: stage3Summary,
              focus: focusSummary
            }
          });
        }

        operations.push(outcome.operation);
        focusSummary = await fetchFocusSummary(supabaseAdmin, runId);
        cycleDidWork = true;

        if (outcome.type === 'halt') {
          haltedReason = outcome.reason;
          break;
        }
      }

      if (!cycleDidWork) {
        break;
      }

      cyclesCompleted += 1;
    }
  }

  // Refresh metrics after potential changes.
  stage1Metrics = await computeStage1Metrics(supabaseAdmin, runId);
  stage2Summary = await fetchStage2Summary(supabaseAdmin, runId);
  stage3Summary = await fetchStage3Summary(supabaseAdmin, runId);
  focusSummary = await fetchFocusSummary(supabaseAdmin, runId);

  const finalCost = await fetchCostSummary(supabaseAdmin, runId);
  totalCost = finalCost.totalCost;

  let budgetExceeded = budgetConfigured && totalCost >= budgetValue - 0.0005;

  if (budgetExceeded && !stopRequested) {
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('runs')
      .update({ stop_requested: true })
      .eq('id', runId)
      .select('stop_requested')
      .maybeSingle();
    if (updateError) {
      console.warn('Failed to set stop_requested after final budget check', updateError);
    } else if (updated) {
      stopRequested = Boolean(updated.stop_requested);
    }
  }

  if (!haltedReason && stopRequested) {
    haltedReason = budgetExceeded ? 'budget_exhausted' : 'stop_requested';
  }

  if (!budgetExceeded) {
    budgetExceeded = budgetExceededInitially;
  }

  const processedTotal = operations.reduce((acc, op) => acc + (Number.isFinite(op.processed) ? Number(op.processed) : 0), 0);

  let message: string;
  if (haltedReason === 'budget_exhausted') {
    message = 'Budget exhausted. Auto continue halted.';
  } else if (haltedReason === 'stop_requested') {
    message = 'Run flagged to stop. Auto continue halted.';
  } else if (operations.length === 0) {
    message = 'No pending work for any stage.';
  } else {
    message = `Auto continue processed ${processedTotal} item${processedTotal === 1 ? '' : 's'} across ${cyclesCompleted || 1} cycle${cyclesCompleted === 1 ? '' : 's'}.`;
  }

  const halted = haltedReason
    ? {
        reason: haltedReason,
        message
      }
    : null;

  return jsonResponse(200, {
    run_id: runId,
    run_status: runStatus,
    stop_requested: stopRequested,
    cycles_requested: cycles,
    cycles_completed: cyclesCompleted,
    operations,
    stage_status: {
      stage1: stage1Metrics,
      stage2: stage2Summary,
      stage3: stage3Summary,
      focus: focusSummary
    },
    cost: {
      total_cost: totalCost,
      budget_usd: budgetConfigured ? budgetValue : null,
      budget_exhausted: budgetExceeded,
      total_tokens_in: finalCost.totalTokensIn,
      total_tokens_out: finalCost.totalTokensOut
    },
    halted,
    message,
    timestamp: new Date().toISOString()
  });
});
