import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type JsonRecord = Record<string, unknown>;

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

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
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
    console.error('Missing Supabase configuration for runs-stop');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload for runs-stop', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const requestedRunId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  const runId = isUuid(requestedRunId) ? requestedRunId : null;
  if (!runId) {
    return jsonResponse(400, { error: 'Valid run_id is required' });
  }

  const stopRequested = Boolean(payload?.stop_requested);

  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const accessToken = tokenMatch?.[1]?.trim();
  if (!accessToken) {
    return jsonResponse(401, { error: 'Missing bearer token' });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    console.error('Invalid session token for runs-stop', userError);
    return jsonResponse(401, { error: 'Invalid or expired session token' });
  }

  const [profileResult, membershipResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
    supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
  ]);

  if (profileResult.error) {
    console.error('Failed to load profile for runs-stop', profileResult.error);
  }
  if (membershipResult.error) {
    console.error('Failed to load membership for runs-stop', membershipResult.error);
  }

  const context = {
    user: userData.user as JsonRecord,
    profile: (profileResult.data ?? null) as JsonRecord | null,
    membership: (membershipResult.data ?? null) as JsonRecord | null
  };

  if (!isAdminContext(context)) {
    return jsonResponse(403, { error: 'Admin access required' });
  }

  const { data: runRecord, error: loadError } = await supabaseAdmin
    .from('runs')
    .select('id, status, stop_requested, notes, created_at')
    .eq('id', runId)
    .maybeSingle();

  if (loadError) {
    console.error('Failed to load run for runs-stop', loadError);
    return jsonResponse(500, { error: 'Failed to load run', details: loadError.message });
  }

  if (!runRecord) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  if (runRecord.stop_requested === stopRequested) {
    return jsonResponse(200, { message: 'No change', run: runRecord });
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('runs')
    .update({ stop_requested: stopRequested })
    .eq('id', runId)
    .select('id, status, stop_requested, notes, created_at')
    .maybeSingle();

  if (updateError) {
    console.error('Failed to update run stop flag', updateError);
    return jsonResponse(500, { error: 'Failed to update run', details: updateError.message });
  }

  return jsonResponse(200, {
    message: stopRequested ? 'Run flagged to stop' : 'Stop request cleared',
    run: updated
  });
});
