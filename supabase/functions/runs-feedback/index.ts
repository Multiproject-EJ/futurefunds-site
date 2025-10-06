import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-automation-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

type JsonRecord = Record<string, unknown>;

type AuthContext = {
  user: JsonRecord | null;
  isAdmin: boolean;
  membershipActive: boolean;
  token: string | null;
  source: 'user' | 'service';
  email: string | null;
};

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isUuid(value: unknown) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function asText(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
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

function isMembershipActiveRecord(record: JsonRecord | null | undefined) {
  if (!record) return false;
  const status = typeof record?.status === 'string' ? record.status.toLowerCase().trim() : '';
  const activeStates = new Set(['active', 'trialing', 'complimentary']);
  if (activeStates.has(status)) return true;
  const expiresAt = record?.expires_at ?? record?.expiresAt ?? record?.expires_on;
  if (typeof expiresAt === 'string') {
    const date = new Date(expiresAt);
    if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now()) {
      return true;
    }
  }
  return false;
}

async function resolveAuth(req: Request, supabaseAdmin: ReturnType<typeof createClient>): Promise<AuthContext> {
  const serviceAuth = resolveServiceAuth(req);
  const authorization = req.headers.get('Authorization') ?? '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : authorization.startsWith('bearer ')
      ? authorization.slice(7).trim()
      : null;

  if (serviceAuth.authorized) {
    return {
      user: null,
      isAdmin: true,
      membershipActive: true,
      token: null,
      source: 'service',
      email: 'automation@futurefunds.ai'
    };
  }

  if (!token) {
    return {
      user: null,
      isAdmin: false,
      membershipActive: false,
      token: null,
      source: 'user',
      email: null
    };
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    console.warn('Invalid session token', userError);
    return {
      user: null,
      isAdmin: false,
      membershipActive: false,
      token: null,
      source: 'user',
      email: null
    };
  }

  const user = userData.user as JsonRecord;
  const userId = user?.id as string;
  const userEmail = typeof user?.email === 'string' ? String(user.email) : null;

  const [profileResult, membershipResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle(),
    supabaseAdmin.from('memberships').select('*').eq('user_id', userId).maybeSingle()
  ]);

  if (profileResult.error) {
    console.warn('profiles query error', profileResult.error);
  }
  if (membershipResult.error) {
    console.warn('memberships query error', membershipResult.error);
  }

  const profile = profileResult.data as JsonRecord | null;
  const membership = membershipResult.data as JsonRecord | null;

  return {
    user,
    isAdmin: isAdminContext({ user, profile, membership }),
    membershipActive: isMembershipActiveRecord(membership),
    token,
    source: 'user',
    email: userEmail
  };
}

function sanitizeTicker(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 12) return null;
  if (!/^[A-Z0-9_.-]+$/i.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

function normalizeQuestion(value: unknown) {
  const text = asText(value);
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

async function handleList(runId: string, supabaseAdmin: ReturnType<typeof createClient>) {
  const { data, error } = await supabaseAdmin.rpc('run_feedback_for_run', { p_run_id: runId });
  if (error) {
    console.error('run_feedback_for_run error', error);
    return jsonResponse(500, { error: 'Failed to load feedback requests', details: error.message });
  }
  return jsonResponse(200, { items: data ?? [] });
}

async function handleCreate(
  req: Request,
  supabaseAdmin: ReturnType<typeof createClient>,
  auth: AuthContext
) {
  const payload = await req.json().catch(() => null);
  const runId = payload?.run_id ?? payload?.runId;
  const question = normalizeQuestion(payload?.question ?? payload?.question_text ?? payload?.message);
  const ticker = sanitizeTicker(payload?.ticker ?? payload?.symbol);
  const context = payload?.context && typeof payload.context === 'object' ? payload.context : null;

  if (!isUuid(runId)) {
    return jsonResponse(400, { error: 'Valid run_id is required' });
  }

  if (!question || question.length < 8) {
    return jsonResponse(400, { error: 'Question must be at least 8 characters' });
  }

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .select('id')
    .eq('id', runId)
    .maybeSingle();

  if (runError) {
    console.error('runs lookup failed', runError);
    return jsonResponse(500, { error: 'Failed to verify run', details: runError.message });
  }

  if (!runRow) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  if (!auth.isAdmin && !auth.membershipActive) {
    return jsonResponse(403, { error: 'Membership required to submit follow-up questions' });
  }

  if (ticker) {
    const { count, error: tickerError } = await supabaseAdmin
      .from('run_items')
      .select('ticker', { count: 'exact', head: true })
      .eq('run_id', runId)
      .eq('ticker', ticker);
    if (tickerError) {
      console.error('run_items ticker validation failed', tickerError);
      return jsonResponse(500, { error: 'Failed to validate ticker', details: tickerError.message });
    }
    if ((count ?? 0) === 0) {
      return jsonResponse(400, { error: `Ticker ${ticker} is not part of this run` });
    }
  }

  const now = new Date().toISOString();
  const insertPayload: JsonRecord = {
    run_id: runId,
    ticker: ticker ?? null,
    question_text: question,
    status: 'pending',
    context: context,
    created_at: now,
    updated_at: now,
    created_by: auth.user?.id ?? null,
    created_by_email: auth.email
  };

  const { data, error } = await supabaseAdmin
    .from('run_feedback')
    .insert([insertPayload])
    .select()
    .maybeSingle();

  if (error) {
    console.error('run_feedback insert failed', error);
    return jsonResponse(500, { error: 'Failed to save follow-up request', details: error.message });
  }

  return jsonResponse(201, { item: data });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Supabase environment variables are not configured' });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const auth = await resolveAuth(req, supabaseAdmin);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const runId = url.searchParams.get('run_id') ?? url.searchParams.get('runId');
    if (!isUuid(runId)) {
      return jsonResponse(400, { error: 'Valid run_id query parameter is required' });
    }

    if (!auth.isAdmin && !auth.membershipActive) {
      return jsonResponse(403, { error: 'Membership required to view feedback requests' });
    }

    return await handleList(runId, supabaseAdmin);
  }

  if (req.method === 'POST') {
    return await handleCreate(req, supabaseAdmin, auth);
  }

  return jsonResponse(405, { error: 'Method not allowed' });
});
