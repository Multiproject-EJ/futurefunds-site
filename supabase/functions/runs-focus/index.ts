import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-automation-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
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
  userId: string | null;
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
    Object.values(source as Record<string, unknown>).forEach((entry) =>
      collectRoles(entry, bucket)
    );
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
    'is_staff'
  ];
  return flagKeys.some((key) => Boolean((record as Record<string, unknown>)[key]));
}

function isAdminContext(context: {
  user: JsonRecord | null;
  profile: JsonRecord | null;
  membership: JsonRecord | null;
}) {
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

function sanitizeTicker(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 12) return null;
  if (!/^[A-Z0-9_.-]+$/i.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

function asText(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

async function resolveAuth(
  req: Request,
  supabaseAdmin: ReturnType<typeof createClient>
): Promise<AuthContext> {
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
      email: 'automation@futurefunds.ai',
      userId: null
    };
  }

  if (!token) {
    return {
      user: null,
      isAdmin: false,
      membershipActive: false,
      token: null,
      source: 'user',
      email: null,
      userId: null
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
      email: null,
      userId: null
    };
  }

  const user = userData.user as JsonRecord;
  const userId = typeof user?.id === 'string' ? (user.id as string) : null;
  const userEmail = typeof user?.email === 'string' ? (user.email as string) : null;

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
    email: userEmail,
    userId
  };
}

function normalizeQuestion(value: unknown) {
  const text = asText(value);
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

async function handleList(
  supabaseAdmin: ReturnType<typeof createClient>,
  runId: string,
  ticker: string | null
) {
  const query = supabaseAdmin
    .from('focus_question_requests')
    .select(
      'id, run_id, ticker, question, status, answer_text, cache_hit, created_at, updated_at, answered_at, template:focus_question_templates(id, slug, label)'
    )
    .eq('run_id', runId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (ticker) {
    query.eq('ticker', ticker);
  }

  const [requestsResult, templatesResult, metricsResult] = await Promise.all([
    query,
    supabaseAdmin.from('focus_question_templates').select('id, slug, label, question').order('label', {
      ascending: true
    }),
    supabaseAdmin.rpc('run_focus_summary', { p_run_id: runId }).maybeSingle()
  ]);

  if (requestsResult.error) {
    console.error('focus_question_requests query failed', requestsResult.error);
    return jsonResponse(500, { error: 'Failed to load focus questions' });
  }

  if (templatesResult.error) {
    console.error('focus_question_templates query failed', templatesResult.error);
    return jsonResponse(500, { error: 'Failed to load focus templates' });
  }

  if (metricsResult.error) {
    console.error('run_focus_summary failed', metricsResult.error);
  }

  return jsonResponse(200, {
    run_id: runId,
    ticker,
    requests: requestsResult.data ?? [],
    templates: templatesResult.data ?? [],
    metrics: metricsResult.data ?? null
  });
}

async function handleCreate(
  supabaseAdmin: ReturnType<typeof createClient>,
  auth: AuthContext,
  payload: any
) {
  const runId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  if (!isUuid(runId)) {
    return jsonResponse(400, { error: 'Valid run_id required' });
  }

  const ticker = sanitizeTicker(payload?.ticker);
  if (!ticker) {
    return jsonResponse(400, { error: 'Ticker required' });
  }

  const templateSlugs = Array.isArray(payload?.template_slugs)
    ? (payload.template_slugs as unknown[]).map((entry) => asText(entry)).filter(Boolean)
    : [];

  const customQuestions = Array.isArray(payload?.custom_questions)
    ? (payload.custom_questions as unknown[]).map((entry) => normalizeQuestion(entry)).filter(Boolean)
    : [];

  const singleQuestion = normalizeQuestion(payload?.question);
  if (singleQuestion) {
    customQuestions.push(singleQuestion);
  }

  if (!templateSlugs.length && !customQuestions.length) {
    return jsonResponse(400, { error: 'Provide at least one focus question or template slug' });
  }

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .select('id')
    .eq('id', runId)
    .maybeSingle();

  if (runError) {
    console.error('Failed to load run for focus-create', runError);
    return jsonResponse(500, { error: 'Failed to load run' });
  }

  if (!runRow) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  const { data: runItem, error: itemError } = await supabaseAdmin
    .from('run_items')
    .select('run_id, ticker')
    .eq('run_id', runId)
    .eq('ticker', ticker)
    .maybeSingle();

  if (itemError) {
    console.error('Failed to verify ticker for run', itemError);
    return jsonResponse(500, { error: 'Failed to verify ticker for run' });
  }

  if (!runItem) {
    return jsonResponse(400, { error: 'Ticker not part of the requested run' });
  }

  const templates: Array<{ id: number; slug: string; label: string; question: string }> = [];
  if (templateSlugs.length) {
    const { data: templateRows, error: templateError } = await supabaseAdmin
      .from('focus_question_templates')
      .select('id, slug, label, question')
      .in('slug', templateSlugs)
      .order('label', { ascending: true });

    if (templateError) {
      console.error('focus_question_templates fetch failed', templateError);
      return jsonResponse(500, { error: 'Failed to load focus templates' });
    }

    const foundSlugs = new Set((templateRows ?? []).map((row) => row.slug));
    const missing = templateSlugs.filter((slug) => !foundSlugs.has(slug));
    if (missing.length) {
      return jsonResponse(400, { error: `Unknown template slugs: ${missing.join(', ')}` });
    }

    templates.push(...(templateRows ?? []));
  }

  const pendingInsertions: Array<Promise<any>> = [];
  const inserted: any[] = [];

  async function enqueueInsert({
    template,
    question
  }: {
    template: { id: number; slug: string; label: string; question: string } | null;
    question: string;
  }) {
    const duplicateQuery = supabaseAdmin
      .from('focus_question_requests')
      .select('id')
      .eq('run_id', runId)
      .eq('ticker', ticker)
      .eq('question', question)
      .in('status', ['pending', 'queued', 'in_progress'])
      .limit(1);
    if (template) {
      duplicateQuery.eq('template_id', template.id);
    }

    const { data: duplicate } = await duplicateQuery.maybeSingle();
    if (duplicate) {
      return;
    }

    const insertResult = await supabaseAdmin
      .from('focus_question_requests')
      .insert({
        run_id: runId,
        ticker,
        template_id: template?.id ?? null,
        question,
        status: 'pending',
        created_by: auth.userId,
        created_by_email: auth.email
      })
      .select(
        'id, run_id, ticker, question, status, created_at, template:focus_question_templates(id, slug, label)'
      )
      .single();

    if (insertResult.error) {
      throw insertResult.error;
    }

    inserted.push(insertResult.data);
  }

  templates.forEach((template) => {
    pendingInsertions.push(enqueueInsert({ template, question: template.question }));
  });

  customQuestions.forEach((question) => {
    pendingInsertions.push(enqueueInsert({ template: null, question }));
  });

  try {
    await Promise.all(pendingInsertions);
  } catch (error) {
    console.error('Failed to insert focus questions', error);
    return jsonResponse(500, { error: 'Failed to add focus questions' });
  }

  return jsonResponse(200, {
    run_id: runId,
    ticker,
    inserted_count: inserted.length,
    requests: inserted
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing Supabase configuration for runs-focus');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const auth = await resolveAuth(req, supabaseAdmin);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const runId = url.searchParams.get('run_id')?.trim() ?? '';
    const ticker = sanitizeTicker(url.searchParams.get('ticker'));

    if (!isUuid(runId)) {
      return jsonResponse(400, { error: 'Valid run_id required' });
    }

    if (auth.source === 'user') {
      if (!auth.token) {
        return jsonResponse(401, { error: 'Missing bearer token' });
      }
      if (!auth.isAdmin || !auth.membershipActive) {
        return jsonResponse(403, { error: 'Admin access required' });
      }
    }

    return handleList(supabaseAdmin, runId, ticker);
  }

  if (req.method === 'POST') {
    let payload: any;
    try {
      payload = await req.json();
    } catch (error) {
      console.error('Invalid JSON payload for runs-focus', error);
      return jsonResponse(400, { error: 'Invalid JSON payload' });
    }

    if (auth.source === 'user') {
      if (!auth.token) {
        return jsonResponse(401, { error: 'Missing bearer token' });
      }
      if (!auth.isAdmin) {
        return jsonResponse(403, { error: 'Admin access required' });
      }
      if (!auth.membershipActive) {
        return jsonResponse(403, { error: 'Active membership required' });
      }
    }

    return handleCreate(supabaseAdmin, auth, payload);
  }

  return jsonResponse(405, { error: 'Method not allowed' });
});
