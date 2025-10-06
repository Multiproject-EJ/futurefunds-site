import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { resolveModel } from '../_shared/ai.ts';

type JsonRecord = Record<string, unknown>;

const DEFAULT_STAGE_MODELS = {
  stage1: 'openrouter/gpt-4o-mini',
  stage2: 'openrouter/gpt-5-mini',
  stage3: 'openrouter/gpt-5-preview'
};

const MAX_TICKERS = 60000;

const DAILY_RUN_LIMIT = (() => {
  const raw = Number(Deno.env.get('RUNS_DAILY_LIMIT') ?? '5');
  if (!Number.isFinite(raw)) return 5;
  const normalized = Math.floor(raw);
  if (normalized < 0) return 0;
  return normalized;
})();

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

function normalizeCredentialId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (['true', 'yes', 'y', '1', 'on'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0', 'off'].includes(normalized)) return false;
  }
  return fallback;
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

function isMembershipActiveRecord(record: JsonRecord | null | undefined) {
  if (!record) return false;
  const status = String(record.status ?? '').toLowerCase();
  if (status && status !== 'active') {
    return false;
  }
  const periodEnd = record.current_period_end ? new Date(String(record.current_period_end)).getTime() : NaN;
  if (!Number.isNaN(periodEnd) && periodEnd < Date.now()) {
    return false;
  }
  return true;
}

function sanitizeStage(
  input: any,
  fallback: { model: string; credentialId?: string | null; inTokens: number; outTokens: number }
) {
  return {
    model: typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model,
    credentialId:
      normalizeCredentialId(input?.credentialId ?? null) ?? normalizeCredentialId(fallback?.credentialId ?? null),
    inTokens: clamp(asNumber(input?.inTokens, fallback.inTokens), 0, 1_000_000),
    outTokens: clamp(asNumber(input?.outTokens, fallback.outTokens), 0, 1_000_000)
  };
}

function sanitizePlanner(input: any) {
  const defaults = {
    universe: 40000,
    surviveStage2: 15,
    surviveStage3: 12,
    stage1: { model: DEFAULT_STAGE_MODELS.stage1, credentialId: null, inTokens: 3000, outTokens: 600 },
    stage2: { model: DEFAULT_STAGE_MODELS.stage2, credentialId: null, inTokens: 30000, outTokens: 6000 },
    stage3: { model: DEFAULT_STAGE_MODELS.stage3, credentialId: null, inTokens: 100000, outTokens: 20000 }
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

function sanitizeScope(input: any) {
  const modeRaw = typeof input?.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  let mode: 'universe' | 'watchlist' | 'custom' = 'universe';
  if (modeRaw === 'watchlist' || modeRaw === 'custom') {
    mode = modeRaw;
  }

  const watchlistId = typeof input?.watchlist_id === 'string' ? input.watchlist_id.trim() : null;
  const watchlistSlug = typeof input?.watchlist_slug === 'string' ? input.watchlist_slug.trim() : null;
  const exchange = typeof input?.exchange === 'string' && input.exchange.trim() ? input.exchange.trim().toUpperCase() : null;
  const source = typeof input?.source === 'string' && input.source.trim() ? input.source.trim() : null;
  const limitRaw = asNumber(input?.limit, 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;
  const includeDelisted = parseBoolean(input?.include_delisted ?? input?.includeInactive ?? input?.include_inactive, false);
  const tickers = Array.isArray(input?.tickers)
    ? Array.from(new Set(input.tickers.map(normalizeTicker).filter((value): value is string => Boolean(value))))
    : [];

  return {
    mode,
    watchlistId,
    watchlistSlug,
    exchange,
    source,
    limit,
    includeDelisted,
    tickers
  };
}

async function ensureTickersExist(
  client: ReturnType<typeof createClient>,
  tickers: string[],
  context: { exchange?: string | null; source?: string | null }
) {
  if (!tickers.length) {
    return { created: [] as string[] };
  }

  const { data: existingRows, error: existingError } = await client
    .from('tickers')
    .select('ticker')
    .in('ticker', tickers);

  if (existingError) {
    throw existingError;
  }

  const existingSet = new Set<string>((existingRows ?? []).map((row) => String(row.ticker)));
  const missing = tickers.filter((ticker) => !existingSet.has(ticker));
  if (!missing.length) {
    return { created: [] as string[] };
  }

  const now = new Date().toISOString();
  const rows = missing.map((ticker) => ({
    ticker,
    exchange: context.exchange ?? null,
    status: 'unknown',
    source: context.source ?? null,
    last_seen_at: now,
    updated_at: now
  }));

  const { error: upsertError } = await client.from('tickers').upsert(rows, { onConflict: 'ticker' });
  if (upsertError) {
    throw upsertError;
  }

  return { created: missing };
}

function estimateCost(
  planner: ReturnType<typeof sanitizePlanner>,
  stageModels: {
    stage1: { price_in?: number | null; price_out?: number | null };
    stage2: { price_in?: number | null; price_out?: number | null };
    stage3: { price_in?: number | null; price_out?: number | null };
  }
) {
  const survivorsStage2 = Math.round(planner.universe * (planner.surviveStage2 / 100));
  const survivorsStage3 = Math.round(survivorsStage2 * (planner.surviveStage3 / 100));

  const stageCost = (
    count: number,
    tokensIn: number,
    tokensOut: number,
    model: { price_in?: number | null; price_out?: number | null }
  ) => {
    if (!count) return 0;
    const priceIn = Number(model?.price_in ?? 0);
    const priceOut = Number(model?.price_out ?? 0);
    const inCost = (count * tokensIn / 1_000_000) * priceIn;
    const outCost = (count * tokensOut / 1_000_000) * priceOut;
    return inCost + outCost;
  };

  const stage1 = stageCost(planner.universe, planner.stage1.inTokens, planner.stage1.outTokens, stageModels.stage1);
  const stage2 = stageCost(survivorsStage2, planner.stage2.inTokens, planner.stage2.outTokens, stageModels.stage2);
  const stage3 = stageCost(survivorsStage3, planner.stage3.inTokens, planner.stage3.outTokens, stageModels.stage3);

  return {
    stage1,
    stage2,
    stage3,
    total: stage1 + stage2 + stage3,
    survivors: {
      stage2: survivorsStage2,
      stage3: survivorsStage3
    }
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

  let scope = sanitizeScope(payload?.scope ?? {});
  if (normalizedTickers.length > 0) {
    scope = { ...scope, mode: 'custom', tickers: normalizedTickers };
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

  const user = userData.user as JsonRecord;
  const userId = user?.id as string;
  const userEmail = typeof user?.email === 'string' ? String(user.email) : null;

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

  const isAdmin = isAdminContext({ user, profile, membership });
  const membershipActive = isMembershipActiveRecord(membership);

  if (!isAdmin) {
    return jsonResponse(403, { error: 'Admin access required' });
  }

  if (DAILY_RUN_LIMIT > 0) {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count: recentCount, error: recentError } = await supabaseAdmin
      .from('runs')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userId)
      .gte('created_at', since);
    if (recentError) {
      console.error('Failed to evaluate run quota', recentError);
      return jsonResponse(500, { error: 'Failed to evaluate quota', details: recentError.message });
    }
    if ((recentCount ?? 0) >= DAILY_RUN_LIMIT) {
      return jsonResponse(429, {
        error: 'Daily run quota reached',
        limit: DAILY_RUN_LIMIT,
        runs_created: recentCount ?? 0,
        window_hours: 24
      });
    }
  }

  let stageModels: { stage1: any; stage2: any; stage3: any };
  try {
    stageModels = {
      stage1: await resolveModel(supabaseAdmin, planner.stage1.model ?? '', DEFAULT_STAGE_MODELS.stage1),
      stage2: await resolveModel(supabaseAdmin, planner.stage2.model ?? '', DEFAULT_STAGE_MODELS.stage2),
      stage3: await resolveModel(supabaseAdmin, planner.stage3.model ?? '', DEFAULT_STAGE_MODELS.stage3)
    };
  } catch (error) {
    console.error('Failed to resolve stage models', error);
    return jsonResponse(500, {
      error: 'Model configuration error',
      details: error instanceof Error ? error.message : String(error)
    });
  }

  planner.stage1.model = stageModels.stage1.slug;
  planner.stage2.model = stageModels.stage2.slug;
  planner.stage3.model = stageModels.stage3.slug;

  let watchlistMeta: { id: string; slug: string | null; name: string | null } | null = null;
  let tickers: string[] = [];

  if (scope.mode === 'watchlist') {
    const selector = scope.watchlistId ? { column: 'id', value: scope.watchlistId } : { column: 'slug', value: scope.watchlistSlug };
    if (!selector.value) {
      return jsonResponse(400, { error: 'Watchlist identifier required', details: 'Provide watchlist_id or watchlist_slug' });
    }

    let watchlistQuery = supabaseAdmin
      .from('watchlists')
      .select('id, slug, name')
      .limit(1);
    watchlistQuery = watchlistQuery.eq(selector.column, selector.value);

    const { data: watchlistRow, error: watchlistError } = await watchlistQuery.maybeSingle();
    if (watchlistError) {
      console.error('Failed to resolve watchlist', watchlistError);
      return jsonResponse(500, { error: 'Failed to resolve watchlist', details: watchlistError.message });
    }
    if (!watchlistRow) {
      return jsonResponse(404, { error: 'Watchlist not found', details: selector.value });
    }

    watchlistMeta = {
      id: String(watchlistRow.id),
      slug: typeof watchlistRow.slug === 'string' ? watchlistRow.slug : null,
      name: typeof watchlistRow.name === 'string' ? watchlistRow.name : null
    };

    const { data: entryRows, error: entryError } = await supabaseAdmin
      .from('watchlist_entries')
      .select('ticker')
      .eq('watchlist_id', watchlistMeta.id)
      .is('removed_at', null)
      .order('rank', { ascending: true, nullsLast: true })
      .order('ticker', { ascending: true });

    if (entryError) {
      console.error('Failed to load watchlist entries', entryError);
      return jsonResponse(500, { error: 'Failed to load watchlist entries', details: entryError.message });
    }

    tickers = Array.from(
      new Set(
        (entryRows ?? [])
          .map((row) => normalizeTicker(row.ticker))
          .filter((value): value is string => Boolean(value))
      )
    );

    if (!tickers.length) {
      return jsonResponse(404, { error: 'Watchlist has no active tickers' });
    }

    const limit = scope.limit ? clamp(asNumber(scope.limit, tickers.length), 1, Math.min(MAX_TICKERS, tickers.length)) : Math.min(MAX_TICKERS, tickers.length);
    tickers = tickers.slice(0, limit);
    planner.universe = tickers.length;
  } else if (scope.mode === 'custom') {
    const candidates = scope.tickers.length ? scope.tickers : normalizedTickers;
    tickers = Array.from(
      new Set(
        candidates
          .map((ticker) => normalizeTicker(ticker))
          .filter((value): value is string => Boolean(value))
      )
    );

    if (!tickers.length) {
      return jsonResponse(400, { error: 'No custom tickers provided' });
    }

    const limit = scope.limit ? clamp(asNumber(scope.limit, tickers.length), 1, Math.min(MAX_TICKERS, tickers.length)) : Math.min(MAX_TICKERS, tickers.length);
    tickers = tickers.slice(0, limit);
    planner.universe = tickers.length;
  } else {
    const limitBase = scope.limit ?? planner.universe || MAX_TICKERS;
    const limit = clamp(asNumber(limitBase, planner.universe || MAX_TICKERS), 1, MAX_TICKERS);
    let universeTickers = normalizedTickers.length
      ? Array.from(new Set(normalizedTickers))
      : [];

    if (!universeTickers.length) {
      let query = supabaseAdmin
        .from('tickers')
        .select('ticker')
        .order('updated_at', { ascending: false, nullsLast: true })
        .order('ticker', { ascending: true })
        .limit(limit);

      if (scope.exchange) {
        query = query.eq('exchange', scope.exchange);
      }
      if (!scope.includeDelisted) {
        query = query.neq('status', 'delisted');
      }

      const { data, error } = await query;
      if (error) {
        console.error('Failed to load tickers', error);
        return jsonResponse(500, { error: 'Failed to load tickers', details: error.message });
      }

      universeTickers = (data ?? [])
        .map((row) => normalizeTicker(row.ticker))
        .filter((value): value is string => Boolean(value));
    }

    if (!universeTickers.length) {
      return jsonResponse(404, { error: 'No tickers available to enqueue' });
    }

    tickers = universeTickers.slice(0, limit);
    planner.universe = tickers.length;
  }

  let createdTickers: string[] = [];
  try {
    const ensured = await ensureTickersExist(supabaseAdmin, tickers, {
      exchange: scope.exchange ?? null,
      source:
        scope.source ??
        (watchlistMeta?.slug ? `watchlist:${watchlistMeta.slug}` : scope.mode === 'custom' ? 'planner:custom' : 'planner:universe')
    });
    createdTickers = ensured.created;
  } catch (error) {
    console.error('Failed to ensure ticker records', error);
    return jsonResponse(500, {
      error: 'Failed to provision tickers',
      details: error instanceof Error ? error.message : String(error)
    });
  }

  const estimatedCost = estimateCost(planner, stageModels);

  const runSummary = {
    planner,
    estimated_cost: estimatedCost,
    resolved_models: {
      stage1: {
        slug: stageModels.stage1.slug,
        label: stageModels.stage1.label ?? null,
        provider: stageModels.stage1.provider,
        price_in: stageModels.stage1.price_in ?? 0,
        price_out: stageModels.stage1.price_out ?? 0
      },
      stage2: {
        slug: stageModels.stage2.slug,
        label: stageModels.stage2.label ?? null,
        provider: stageModels.stage2.provider,
        price_in: stageModels.stage2.price_in ?? 0,
        price_out: stageModels.stage2.price_out ?? 0
      },
      stage3: {
        slug: stageModels.stage3.slug,
        label: stageModels.stage3.label ?? null,
        provider: stageModels.stage3.provider,
        price_in: stageModels.stage3.price_in ?? 0,
        price_out: stageModels.stage3.price_out ?? 0
      }
    },
    requested_tickers: scope.mode === 'custom' ? (scope.tickers.length || normalizedTickers.length) : normalizedTickers.length,
    resolved_tickers: tickers.length,
    scope: {
      mode: scope.mode,
      watchlist: watchlistMeta
        ? { id: watchlistMeta.id, slug: watchlistMeta.slug, name: watchlistMeta.name }
        : null,
      limit: scope.limit,
      exchange: scope.exchange ?? null,
      include_delisted: scope.includeDelisted,
      source: scope.source ?? null,
      created_tickers: createdTickers,
      custom_preview: scope.mode === 'custom' ? tickers.slice(0, 20) : null
    },
    created_at: new Date().toISOString(),
    created_by: userId,
    client_meta: payload?.client_meta ?? null,
    membership_active: membershipActive,
    quota_limit: DAILY_RUN_LIMIT,
    quota_window_hours: 24,
    created_by_email: userEmail
  };

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .insert({
      status: 'running',
      notes: JSON.stringify(runSummary),
      created_by: userId,
      created_by_email: userEmail,
      watchlist_id: watchlistMeta?.id ?? null
    })
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
    estimated_cost: runSummary.estimated_cost,
    resolved_models: runSummary.resolved_models,
    scope: runSummary.scope,
    created_tickers: createdTickers
  });
});
