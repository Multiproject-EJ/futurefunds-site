import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

type JsonRecord = Record<string, unknown>;

type HealthCheck = {
  status: 'ok' | 'degraded' | 'error';
  latency_ms?: number;
  message?: string;
};

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
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
  const flagKeys = [
    'is_admin',
    'admin',
    'isAdmin',
    'is_superadmin',
    'superuser',
    'staff',
    'is_staff',
    'claims_admin',
    'admin_claims',
    'is_operator',
    'operator',
    'operator_access',
    'ops',
    'ops_admin',
    'is_ops',
    'staff_access'
  ];
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
  collectRoles((profile as JsonRecord | null)?.plan, bucket);
  collectRoles((profile as JsonRecord | null)?.tier, bucket);
  collectRoles((profile as JsonRecord | null)?.team, bucket);
  collectRoles((profile as JsonRecord | null)?.department, bucket);
  collectRoles((profile as JsonRecord | null)?.groups, bucket);
  collectRoles((profile as JsonRecord | null)?.labels, bucket);
  collectRoles((profile as JsonRecord | null)?.tags, bucket);

  collectRoles(user?.app_metadata, bucket);
  collectRoles(user?.user_metadata, bucket);

  collectRoles(membership?.role, bucket);
  collectRoles(membership?.roles, bucket);
  collectRoles(membership?.access_level, bucket);
  collectRoles(membership?.plan, bucket);
  collectRoles(membership?.plan_name, bucket);
  collectRoles(membership?.tier, bucket);
  collectRoles((membership as JsonRecord | null)?.labels, bucket);
  collectRoles((membership as JsonRecord | null)?.tags, bucket);

  const privileged = new Set([
    'admin',
    'administrator',
    'superadmin',
    'owner',
    'editor',
    'staff',
    'operator',
    'operations',
    'ops',
    'internal',
    'maintainer',
    'automation',
    'builder'
  ]);
  for (const role of bucket) {
    if (privileged.has(role)) {
      return true;
    }
  }

  return false;
}

async function checkDatabase(client: ReturnType<typeof createClient>): Promise<HealthCheck> {
  const started = performance.now();
  try {
    const { error } = await client
      .from('runs')
      .select('id', { head: true, count: 'exact' })
      .limit(1);
    if (error) throw error;
    const latency = Math.round(performance.now() - started);
    return { status: 'ok', latency_ms: latency, message: 'Database reachable' };
  } catch (error) {
    const latency = Math.round(performance.now() - started);
    return {
      status: 'error',
      latency_ms: latency,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkOpenAI(): Promise<HealthCheck> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    return { status: 'degraded', message: 'OPENAI_API_KEY not configured' };
  }

  const controller = AbortSignal.timeout(5000);
  const started = performance.now();
  try {
    const response = await fetch('https://api.openai.com/v1/models?limit=1', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller
    });
    const latency = Math.round(performance.now() - started);
    if (response.status === 401 || response.status === 403) {
      return { status: 'error', latency_ms: latency, message: `OpenAI authentication failed (${response.status})` };
    }
    if (!response.ok) {
      return { status: 'degraded', latency_ms: latency, message: `Unexpected OpenAI status ${response.status}` };
    }
    return { status: 'ok', latency_ms: latency, message: 'OpenAI reachable' };
  } catch (error) {
    const latency = Math.round(performance.now() - started);
    return {
      status: 'error',
      latency_ms: latency,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing Supabase configuration for health check');
    return jsonResponse(500, { error: 'Server misconfigured' });
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
    console.error('Invalid session token for health endpoint', userError);
    return jsonResponse(401, { error: 'Invalid or expired session token' });
  }

  const [profileResult, membershipResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
    supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
  ]);

  if (!isAdminContext({
    user: userData.user as JsonRecord,
    profile: (profileResult.data ?? null) as JsonRecord | null,
    membership: (membershipResult.data ?? null) as JsonRecord | null
  })) {
    return jsonResponse(403, { error: 'Admin access required' });
  }

  const [dbCheck, openaiCheck] = await Promise.all([checkDatabase(supabaseAdmin), checkOpenAI()]);

  const checks = {
    database: dbCheck,
    openai: openaiCheck
  };

  const overallStatus = [dbCheck.status, openaiCheck.status].includes('error')
    ? 'error'
    : [dbCheck.status, openaiCheck.status].includes('degraded')
      ? 'degraded'
      : 'ok';

  const statusCode = overallStatus === 'error' ? 503 : 200;

  return jsonResponse(statusCode, {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks
  });
});
