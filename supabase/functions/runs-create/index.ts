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

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return null;
  if (!/^[A-Z0-9\-\.]+$/.test(trimmed)) return null;
  return trimmed;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function asNumber(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

function sanitizeStage(input: any, fallback: { model: string; inTokens: number; outTokens: number }) {
  return {
    model: typeof input?.model === 'string' ? input.model : fallback.model,
    inTokens: clamp(asNumber(input?.inTokens, fallback.inTokens), 0, 1_000_000),
    outTokens: clamp(asNumber(input?.outTokens, fallback.outTokens), 0, 1_000_000)
  };
}

function sanitizePlanner(input: any) {
  const defaults = {
    universe: 40000,
    surviveStage2: 15,
    surviveStage3: 12,
    stage1: { model: '4o-mini', inTokens: 3000, outTokens: 600 },
    stage2: { model: '5-mini', inTokens: 30000, outTokens: 6000 },
    stage3: { model: '5', inTokens: 100000, outTokens: 20000 }
  };

  const universe = clamp(asNumber(input?.universe, defaults.universe), 0, 60000);
  const surviveStage2 = clamp(asNumber(input?.surviveStage2, defaults.surviveStage2), 0, 100);
  const surviveStage3 = clamp(asNumber(input?.surviveStage3, defaults.surviveStage3), 0, 100);

  return {
    universe,
    surviveStage2,
    surviveStage3,
    stage1: sanitizeStage(input?.stage1, defaults.stage1),
    stage2: sanitizeStage(input?.stage2, defaults.stage2),
    stage3: sanitizeStage(input?.stage3, defaults.stage3)
  };
}

function estimateCost(planner: ReturnType<typeof sanitizePlanner>) {
  const survivorsStage2 = Math.round(planner.universe * (planner.surviveStage2 / 100));
  const survivorsStage3 = Math.round(survivorsStage2 * (planner.surviveStage3 / 100));

  const costs = {
    '5': { in: 1.25, out: 10.0 },
    '5-mini': { in: 0.25, out: 2.0 },
    '4o-mini': { in: 0.15, out: 0.60 }
  } as Record<string, { in: number; out: number }>;

  const stageCost = (count: number, tokensIn: number, tokensOut: number, model: string) => {
    const price = costs[model];
    if (!price || !count) return 0;
    const inCost = (count * tokensIn / 1_000_000) * price.in;
    const outCost = (count * tokensOut / 1_000_000) * price.out;
    return inCost + outCost;
  };

  const stage1 = stageCost(planner.universe, planner.stage1.inTokens, planner.stage1.outTokens, planner.stage1.model);
  const stage2 = stageCost(survivorsStage2, planner.stage2.inTokens, planner.stage2.outTokens, planner.stage2.model);
  const stage3 = stageCost(survivorsStage3, planner.stage3.inTokens, planner.stage3.outTokens, planner.stage3.model);

  return {
    stage1,
    stage2,
    stage3,
    total: stage1 + stage2 + stage3
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
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing Supabase configuration.');
    return jsonResponse(500, { error: 'Server not configured for Supabase access' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const planner = sanitizePlanner(payload?.planner ?? {});
  const rawTickers = Array.isArray(payload?.tickers) ? payload.tickers : [];
  const normalizedTickers = Array.from(new Set(rawTickers.map(normalizeTicker).filter((value): value is string => Boolean(value))));

  const requestedUniverse = planner.universe || normalizedTickers.length;
  const MAX_TICKERS = 60000;
  const targetCount = clamp(normalizedTickers.length > 0 ? normalizedTickers.length : requestedUniverse, 1, MAX_TICKERS);

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

  const user = userData.user as JsonRecord;
  const userId = user?.id as string;

  const [profileResult, membershipResult] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle(),
    supabaseAdmin
      .from('memberships')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
  ]);

  if (profileResult.error) {
    console.warn('profiles query error', profileResult.error);
  }
  if (membershipResult.error) {
    console.warn('memberships query error', membershipResult.error);
  }

  const profile = profileResult.data as JsonRecord | null;
  const membership = membershipResult.data as JsonRecord | null;

  if (!isAdminContext({ user, profile, membership })) {
    return jsonResponse(403, { error: 'Admin access required' });
  }

  let tickers = normalizedTickers;
  if (tickers.length === 0) {
    const { data, error } = await supabaseAdmin
      .from('tickers')
      .select('ticker')
      .order('updated_at', { ascending: false, nullsLast: true })
      .order('ticker', { ascending: true })
      .limit(targetCount);

    if (error) {
      console.error('Failed to load tickers', error);
      return jsonResponse(500, { error: 'Failed to load tickers', details: error.message });
    }

    tickers = (data ?? [])
      .map((row) => normalizeTicker(row.ticker))
      .filter((value): value is string => Boolean(value));
  } else if (tickers.length > targetCount) {
    tickers = tickers.slice(0, targetCount);
  }

  if (tickers.length === 0) {
    return jsonResponse(404, { error: 'No tickers available to enqueue' });
  }

  const runSummary = {
    planner,
    estimated_cost: estimateCost(planner),
    requested_tickers: normalizedTickers.length,
    resolved_tickers: tickers.length,
    created_at: new Date().toISOString(),
    created_by: userId,
    client_meta: payload?.client_meta ?? null
  };

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .insert({ status: 'running', notes: JSON.stringify(runSummary) })
    .select('id')
    .single();

  if (runError || !runRow) {
    console.error('Failed to create run', runError);
    return jsonResponse(500, { error: 'Failed to create run', details: runError?.message ?? null });
  }

  const runId = runRow.id as string;
  const runItems = tickers.map((ticker) => ({
    run_id: runId,
    ticker,
    status: 'pending',
    stage: 0,
    spend_est_usd: 0
  }));

  const chunkSize = 1000;
  for (let index = 0; index < runItems.length; index += chunkSize) {
    const chunk = runItems.slice(index, index + chunkSize);
    const { error } = await supabaseAdmin.from('run_items').insert(chunk);
    if (error) {
      console.error('Failed to insert run items', error);
      await supabaseAdmin.from('runs').update({ status: 'failed' }).eq('id', runId);
      return jsonResponse(500, { error: 'Failed to enqueue tickers', details: error.message, run_id: runId });
    }
  }

  return jsonResponse(200, {
    run_id: runId,
    total_items: runItems.length,
    planner,
    estimated_cost: runSummary.estimated_cost
  });
});
