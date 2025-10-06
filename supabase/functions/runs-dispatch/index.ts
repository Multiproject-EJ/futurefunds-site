import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

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

function jsonResponse(status: number, body: Record<string, unknown>) {
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

function computeDueSchedules(
  schedules: Array<Record<string, unknown>>,
  options: { runIds?: Set<string>; now: number }
) {
  const due: Array<Record<string, unknown>> = [];
  for (const schedule of schedules) {
    if (!schedule.active) continue;
    const runId = typeof schedule.run_id === 'string' ? schedule.run_id : null;
    if (!runId || (options.runIds && !options.runIds.has(runId))) continue;

    const cadenceSeconds = Number(schedule.cadence_seconds ?? 0);
    if (!Number.isFinite(cadenceSeconds) || cadenceSeconds <= 0) continue;

    const runStatus = (schedule.runs as Record<string, unknown> | null)?.status;
    const stopRequested = Boolean((schedule.runs as Record<string, unknown> | null)?.stop_requested);
    if (stopRequested) continue;
    if (runStatus && !['running', 'queued'].includes(String(runStatus))) continue;

    const lastTriggeredRaw = schedule.last_triggered_at ? Date.parse(String(schedule.last_triggered_at)) : NaN;
    const lastTriggered = Number.isFinite(lastTriggeredRaw) ? lastTriggeredRaw : null;
    if (lastTriggered) {
      const delta = options.now - lastTriggered;
      if (delta < cadenceSeconds * 1000) continue;
    }

    due.push(schedule);
  }
  return due;
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
    console.error('Missing Supabase configuration for runs-dispatch');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  const serviceAuth = resolveServiceAuth(req);
  if (!serviceAuth.authorized || !serviceAuth.providedSecret) {
    const status = serviceAuth.reason === 'Service secret not configured' ? 500 : 401;
    return jsonResponse(status, { error: serviceAuth.reason ?? 'Automation secret required' });
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch (_error) {
    payload = {};
  }

  const now = Date.now();
  const limit = clampInteger(payload?.limit, 1, 20, 5);
  const dryRun = payload?.dry_run === true;

  const explicitIds = new Set<string>();
  if (Array.isArray(payload?.run_ids)) {
    for (const entry of payload.run_ids) {
      if (isUuid(entry)) {
        explicitIds.add(String(entry));
      }
    }
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: schedules, error } = await supabaseAdmin
    .from('run_schedules')
    .select('id, run_id, cadence_seconds, stage1_limit, stage2_limit, stage3_limit, max_cycles, active, last_triggered_at, label, runs(status, stop_requested)')
    .eq('active', true);

  if (error) {
    console.error('Failed to load run schedules', error);
    return jsonResponse(500, { error: 'Failed to load run schedules', details: error.message });
  }

  const runIdsFilter = explicitIds.size > 0 ? explicitIds : undefined;
  const dueSchedules = computeDueSchedules(schedules ?? [], { runIds: runIdsFilter, now });

  const functionsBaseUrl = supabaseUrl.replace(/\.supabase\.co$/, '.functions.supabase.co');
  const triggered: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];

  for (const schedule of dueSchedules.slice(0, limit)) {
    const runId = String(schedule.run_id);
    const stageLimits = {
      stage1: Number(schedule.stage1_limit ?? 8) || 8,
      stage2: Number(schedule.stage2_limit ?? 4) || 4,
      stage3: Number(schedule.stage3_limit ?? 2) || 2
    };
    const maxCycles = clampInteger(schedule.max_cycles, 1, 10, 1);

    if (dryRun) {
      skipped.push({
        schedule_id: schedule.id,
        run_id: runId,
        reason: 'dry_run',
        next_attempt_after: new Date(now + Number(schedule.cadence_seconds ?? 0) * 1000).toISOString()
      });
      continue;
    }

    let response: Response | null = null;
    let parsed: Record<string, unknown> | null = null;
    let message: string | null = null;

    try {
      response = await fetch(`${functionsBaseUrl}/runs-continue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-automation-secret': serviceAuth.providedSecret
        },
        body: JSON.stringify({
          run_id: runId,
          stage_limits: stageLimits,
          cycles: maxCycles,
          client_meta: {
            ...(payload?.client_meta && typeof payload.client_meta === 'object' ? payload.client_meta : {}),
            orchestrator: 'runs-dispatch',
            schedule_id: schedule.id,
            dispatched_at: new Date().toISOString()
          }
        })
      });

      const raw = await response.text();
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch (_error) {
          parsed = { raw };
        }
      }
      message = parsed?.message ? String(parsed.message) : null;
    } catch (invokeError) {
      console.error('runs-continue invocation failed', invokeError);
      skipped.push({
        schedule_id: schedule.id,
        run_id: runId,
        reason: 'invoke_failed',
        error: invokeError instanceof Error ? invokeError.message : String(invokeError)
      });
      continue;
    }

    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('run_schedules')
      .update({ last_triggered_at: nowIso, updated_at: nowIso })
      .eq('id', schedule.id);

    if (updateError) {
      console.warn('Failed to update last_triggered_at', updateError);
    }

    triggered.push({
      schedule_id: schedule.id,
      run_id: runId,
      status: response?.status ?? 0,
      ok: response?.ok ?? false,
      message,
      payload: parsed
    });
  }

  const remaining = dueSchedules.length - triggered.length - skipped.length;

  return jsonResponse(200, {
    triggered,
    skipped,
    remaining_due: remaining > 0 ? remaining : 0,
    total_due: dueSchedules.length,
    checked_at: new Date(now).toISOString()
  });
});
