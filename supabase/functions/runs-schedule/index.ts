import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const MAX_STAGE_LIMIT = 25;
const MAX_CYCLES = 10;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isUuid(value: unknown) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  if (Number.isNaN(rounded)) return fallback;
  return Math.min(Math.max(rounded, min), max);
}

function hasAdminMarker(record: Record<string, unknown> | null | undefined) {
  if (!record) return false;
  const flagKeys = ['is_admin', 'admin', 'isAdmin', 'is_superadmin', 'superuser', 'staff', 'is_staff'];
  return flagKeys.some((key) => Boolean((record as Record<string, unknown>)[key]));
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

function isAdminContext(context: { user: Record<string, unknown> | null; profile: Record<string, unknown> | null; membership: Record<string, unknown> | null }) {
  const { user, profile, membership } = context;
  if (hasAdminMarker(profile) || hasAdminMarker(membership) || hasAdminMarker(user ?? undefined)) {
    return true;
  }

  const bucket = new Set<string>();
  collectRoles(profile?.role, bucket);
  collectRoles((profile as Record<string, unknown> | null)?.role_name, bucket);
  collectRoles((profile as Record<string, unknown> | null)?.user_role, bucket);
  collectRoles((profile as Record<string, unknown> | null)?.roles, bucket);
  collectRoles((profile as Record<string, unknown> | null)?.role_tags, bucket);
  collectRoles((profile as Record<string, unknown> | null)?.access_level, bucket);

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

function computeNextTrigger(schedule: Record<string, unknown> | null) {
  if (!schedule) return null;
  if (!schedule.active) return null;
  const cadenceSeconds = Number(schedule.cadence_seconds ?? 0);
  if (!Number.isFinite(cadenceSeconds) || cadenceSeconds <= 0) return null;
  const lastTriggered = schedule.last_triggered_at ? new Date(schedule.last_triggered_at as string).getTime() : null;
  const lastTime = Number.isFinite(lastTriggered ?? NaN) ? (lastTriggered as number) : 0;
  const base = lastTime > 0 ? lastTime : Date.now();
  const next = new Date(base + cadenceSeconds * 1000);
  return next.toISOString();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing Supabase configuration for runs-schedule');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const runIdParam = url.searchParams.get('run_id') ?? '';
    const runId = isUuid(runIdParam) ? runIdParam : null;

    if (!runId) {
      return jsonResponse(400, { error: 'run_id query parameter required' });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const accessToken = tokenMatch?.[1]?.trim();
    if (!accessToken) {
      return jsonResponse(401, { error: 'Missing bearer token' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.error('Invalid session token for runs-schedule', userError);
      return jsonResponse(401, { error: 'Invalid or expired session token' });
    }

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
      supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
    ]);

    if (!isAdminContext({
      user: userData.user as Record<string, unknown>,
      profile: (profileResult.data ?? null) as Record<string, unknown> | null,
      membership: (membershipResult.data ?? null) as Record<string, unknown> | null
    })) {
      return jsonResponse(403, { error: 'Admin access required' });
    }

    const { data, error } = await supabaseAdmin
      .from('run_schedules')
      .select('*')
      .eq('run_id', runId)
      .maybeSingle();

    if (error) {
      console.error('Failed to load run schedule', error);
      return jsonResponse(500, { error: 'Failed to load run schedule', details: error.message });
    }

    return jsonResponse(200, {
      schedule: data
        ? {
            ...data,
            next_trigger_at: computeNextTrigger(data)
          }
        : null
    });
  }

  if (req.method === 'POST') {
    let payload: any;
    try {
      payload = await req.json();
    } catch (error) {
      console.error('Invalid JSON payload for runs-schedule', error);
      return jsonResponse(400, { error: 'Invalid JSON payload' });
    }

    const runIdInput = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
    const runId = isUuid(runIdInput) ? runIdInput : null;
    if (!runId) {
      return jsonResponse(400, { error: 'Valid run_id required' });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const accessToken = tokenMatch?.[1]?.trim();
    if (!accessToken) {
      return jsonResponse(401, { error: 'Missing bearer token' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.error('Invalid session token for runs-schedule update', userError);
      return jsonResponse(401, { error: 'Invalid or expired session token' });
    }

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
      supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
    ]);

    if (!isAdminContext({
      user: userData.user as Record<string, unknown>,
      profile: (profileResult.data ?? null) as Record<string, unknown> | null,
      membership: (membershipResult.data ?? null) as Record<string, unknown> | null
    })) {
      return jsonResponse(403, { error: 'Admin access required' });
    }

    const cadenceSeconds = clampInteger(payload?.cadence_seconds, 60, 21600, 3600);
    const stageLimitsPayload = payload?.stage_limits ?? {};
    const stage1Limit = clampInteger(stageLimitsPayload?.stage1 ?? payload?.stage1_limit, 1, MAX_STAGE_LIMIT, 8);
    const stage2Limit = clampInteger(stageLimitsPayload?.stage2 ?? payload?.stage2_limit, 1, MAX_STAGE_LIMIT, 4);
    const stage3Limit = clampInteger(stageLimitsPayload?.stage3 ?? payload?.stage3_limit, 1, MAX_STAGE_LIMIT, 2);
    const maxCycles = clampInteger(payload?.max_cycles, 1, MAX_CYCLES, 1);
    const active = payload?.active === false ? false : true;
    const label = typeof payload?.label === 'string' ? payload.label.trim().slice(0, 120) : null;

    const upsertPayload = {
      run_id: runId,
      cadence_seconds: cadenceSeconds,
      stage1_limit: stage1Limit,
      stage2_limit: stage2Limit,
      stage3_limit: stage3Limit,
      max_cycles: maxCycles,
      active,
      label,
      updated_at: new Date().toISOString()
    } as Record<string, unknown>;

    if (payload?.reset_last_trigger === true) {
      upsertPayload.last_triggered_at = null;
    }

    const { data, error } = await supabaseAdmin
      .from('run_schedules')
      .upsert(upsertPayload, { onConflict: 'run_id' })
      .select('*')
      .maybeSingle();

    if (error) {
      console.error('Failed to upsert run schedule', error);
      return jsonResponse(500, { error: 'Failed to save run schedule', details: error.message });
    }

    return jsonResponse(200, {
      schedule: data
        ? {
            ...data,
            next_trigger_at: computeNextTrigger(data)
          }
        : null
    });
  }

  return jsonResponse(405, { error: 'Method not allowed' });
});
