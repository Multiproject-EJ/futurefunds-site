import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { parse as parseCsv } from 'https://deno.land/std@0.210.0/csv/mod.ts';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-automation-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const STATUS_VALUES = new Set(['active', 'inactive', 'delisted', 'pending', 'unknown']);
const MAX_RECORDS = 60_000;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return null;
  if (!/^[A-Z0-9\-\.]+$/.test(trimmed)) return null;
  return trimmed;
}

function parseDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  if (!str) return null;
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseBool(value: unknown, fallback = false) {
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

function uniqueArray(values: (string | null | undefined)[]) {
  const set = new Set<string>();
  values.forEach((value) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed) set.add(trimmed);
  });
  return Array.from(set);
}

function asArray(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

type Actor =
  | { type: 'service'; secret: string }
  | { type: 'user'; id: string; email: string | null };

type SanitisedRecord = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  country: string | null;
  currency: string | null;
  sector: string | null;
  industry: string | null;
  status: string;
  listed_at: string | null;
  delisted_at: string | null;
  aliases: string[];
  source: string | null;
  metadata: Record<string, unknown>;
};

function sanitizeRecord(raw: Record<string, unknown>, defaults: { exchange: string | null; source: string | null }) {
  const ticker = normalizeTicker(raw.ticker ?? raw.symbol ?? raw.code);
  if (!ticker) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const exchange =
    typeof raw.exchange === 'string' && raw.exchange.trim()
      ? raw.exchange.trim().toUpperCase()
      : defaults.exchange;
  const country = typeof raw.country === 'string' && raw.country.trim() ? raw.country.trim().toUpperCase() : null;
  const currency = typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim().toUpperCase() : null;
  const sector = typeof raw.sector === 'string' && raw.sector.trim() ? raw.sector.trim() : null;
  const industry = typeof raw.industry === 'string' && raw.industry.trim() ? raw.industry.trim() : null;
  const statusRaw = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : null;
  const status = statusRaw && STATUS_VALUES.has(statusRaw) ? statusRaw : 'active';
  const listed_at = parseDate(raw.listed_at ?? raw.ipo_date ?? raw.listingDate ?? raw.first_listed);
  const delisted_at = parseDate(raw.delisted_at ?? raw.delistingDate ?? raw.last_listed);
  const aliases = uniqueArray(asArray(raw.aliases ?? raw.former_names).map((entry) => (typeof entry === 'string' ? entry : null)));
  const source =
    typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : defaults.source;
  const metadata: Record<string, unknown> = {};

  const candidateKeys = ['figi', 'cik', 'isin', 'lei', 'sic', 'mic', 'primary_exchange', 'homepage', 'notes'];
  candidateKeys.forEach((key) => {
    const value = raw[key];
    if (value === undefined || value === null) return;
    metadata[key] = value;
  });

  return {
    ticker,
    name,
    exchange,
    country,
    currency,
    sector,
    industry,
    status,
    listed_at,
    delisted_at,
    aliases,
    source,
    metadata
  } satisfies SanitisedRecord;
}

type FetchOptions = {
  fallbackHeaders?: Record<string, string>;
};

async function fetchFeedRecords(feed: any, options: FetchOptions = {}) {
  if (!feed || typeof feed !== 'object') return [];
  const url = typeof feed.url === 'string' ? feed.url : null;
  if (!url) return [];

  const headers: Record<string, string> = {};
  if (options.fallbackHeaders) {
    for (const [key, value] of Object.entries(options.fallbackHeaders)) {
      headers[key] = value;
    }
  }
  if (feed.headers && typeof feed.headers === 'object') {
    for (const [key, value] of Object.entries(feed.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Feed responded with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (feed.path && typeof feed.path === 'string') {
      const segments = feed.path.split('.').map((part: string) => part.trim()).filter(Boolean);
      let cursor: any = parsed;
      for (const segment of segments) {
        if (!cursor || typeof cursor !== 'object') {
          cursor = null;
          break;
        }
        cursor = cursor[segment];
      }
      return Array.isArray(cursor) ? cursor : [];
    }
    return Array.isArray(parsed.data) ? parsed.data : [];
  }

  if (contentType.includes('text/csv') || contentType.includes('application/csv')) {
    const records = await parseCsv(text, { skipFirstRow: false });
    if (Array.isArray(records)) {
      return records.map((row) => row as Record<string, unknown>);
    }
  }

  throw new Error('Unsupported feed format. Expected JSON or CSV response.');
}

function extractBearerToken(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return tokenMatch?.[1]?.trim() || null;
}

async function ensureAdmin(supabaseAdmin: ReturnType<typeof createClient>, token: string) {
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return { authorized: false, reason: 'Invalid or expired session token' };
  }

  const user = userData.user;
  const userId = user.id;
  const userEmail = typeof user.email === 'string' ? user.email : null;

  const { data: isAdmin, error: adminError } = await supabaseAdmin.rpc('is_admin', { uid: userId });
  if (adminError) {
    console.error('is_admin rpc error', adminError);
    return { authorized: false, reason: adminError.message };
  }

  if (!isAdmin) {
    return { authorized: false, reason: 'Admin access required' };
  }

  return { authorized: true, actor: { type: 'user', id: userId, email: userEmail } as Actor };
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

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch (error) {
    console.warn('tickers-refresh payload parse failed', error);
  }

  let actor: Actor | null = null;

  const serviceAuth = resolveServiceAuth(req);
  if (serviceAuth.authorized && serviceAuth.providedSecret) {
    actor = { type: 'service', secret: serviceAuth.providedSecret };
  }

  if (!actor) {
    const bearer = extractBearerToken(req);
    if (!bearer) {
      return jsonResponse(401, { error: serviceAuth.reason ?? 'Missing authentication' });
    }
    const adminCheck = await ensureAdmin(supabaseAdmin, bearer);
    if (!adminCheck.authorized || !adminCheck.actor) {
      return jsonResponse(403, { error: adminCheck.reason ?? 'Admin access required' });
    }
    actor = adminCheck.actor;
  }

  const exchange = typeof payload.exchange === 'string' && payload.exchange.trim() ? payload.exchange.trim().toUpperCase() : null;
  const source = typeof payload.source === 'string' && payload.source.trim() ? payload.source.trim() : exchange;
  const markMissing = parseBool(payload.mark_missing, Boolean(exchange));
  const dryRun = parseBool(payload.dry_run, false);

  let rawRecords: any[] = [];
  if (Array.isArray(payload.records)) {
    rawRecords = payload.records as any[];
  } else if (payload.feed) {
    try {
      const feedHasAuthHeader = Boolean(
        payload.feed &&
          typeof payload.feed === 'object' &&
          Object.keys(payload.feed.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
      );
      const fallbackHeaders: Record<string, string> | undefined = !feedHasAuthHeader && Deno.env.get('TICKER_FEED_API_KEY')
        ? { Authorization: `Bearer ${Deno.env.get('TICKER_FEED_API_KEY')}` }
        : undefined;
      rawRecords = await fetchFeedRecords(payload.feed, { fallbackHeaders });
    } catch (error) {
      console.error('tickers-refresh feed error', error);
      return jsonResponse(502, { error: 'Failed to fetch feed', details: error instanceof Error ? error.message : String(error) });
    }
  } else {
    const envFeed = Deno.env.get('TICKER_FEED_URL');
    if (envFeed) {
      try {
        const fallbackHeaders = Deno.env.get('TICKER_FEED_API_KEY')
          ? { Authorization: `Bearer ${Deno.env.get('TICKER_FEED_API_KEY')}` }
          : undefined;
        rawRecords = await fetchFeedRecords({ url: envFeed }, { fallbackHeaders });
      } catch (error) {
        console.error('tickers-refresh default feed error', error);
        return jsonResponse(502, { error: 'Failed to fetch default feed', details: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    return jsonResponse(400, { error: 'No records provided', hint: 'Send records array or configure feed url' });
  }

  if (rawRecords.length > MAX_RECORDS) {
    return jsonResponse(413, {
      error: 'Payload too large',
      limit: MAX_RECORDS,
      received: rawRecords.length
    });
  }

  const defaults = { exchange, source };
  const sanitised = rawRecords
    .map((record) => (record && typeof record === 'object' ? sanitizeRecord(record as Record<string, unknown>, defaults) : null))
    .filter((entry): entry is SanitisedRecord => Boolean(entry));

  if (sanitised.length === 0) {
    return jsonResponse(400, { error: 'No valid tickers found in payload' });
  }

  if (sanitised.length > MAX_RECORDS) {
    return jsonResponse(413, {
      error: 'Too many valid ticker records',
      limit: MAX_RECORDS,
      received: sanitised.length
    });
  }

  const tickerList = Array.from(new Set(sanitised.map((entry) => entry.ticker)));
  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from('tickers')
    .select('ticker, name, exchange, status, aliases, metadata, source, listed_at, delisted_at')
    .in('ticker', tickerList);

  if (existingError) {
    console.error('tickers-refresh existing fetch error', existingError);
    return jsonResponse(500, { error: 'Failed to load existing tickers', details: existingError.message });
  }

  const existingMap = new Map<string, any>();
  (existingRows ?? []).forEach((row) => {
    const key = normalizeTicker(row.ticker);
    if (key) existingMap.set(key, row);
  });

  const now = new Date().toISOString();
  const upserts: any[] = [];
  const events: any[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  sanitised.forEach((record) => {
    const existing = existingMap.get(record.ticker);
    const payloadRow: Record<string, unknown> = {
      ticker: record.ticker,
      name: record.name,
      exchange: record.exchange,
      country: record.country,
      currency: record.currency,
      sector: record.sector,
      industry: record.industry,
      status: record.status,
      listed_at: record.listed_at,
      delisted_at: record.delisted_at,
      aliases: record.aliases,
      source: record.source,
      metadata: record.metadata,
      last_seen_at: now,
      updated_at: now
    };

    let changeDetected = false;
    if (!existing) {
      created.push(record.ticker);
      changeDetected = true;
      events.push({
        ticker: record.ticker,
        event_type: 'created',
        details: {
          name: record.name,
          exchange: record.exchange,
          status: record.status,
          actor: actor.type,
          at: now
        }
      });
    } else {
      const aliasSet = new Set<string>(existing.aliases ?? []);
      if (existing.name && existing.name !== record.name && existing.name.trim()) {
        aliasSet.add(existing.name.trim());
        changeDetected = true;
        events.push({
          ticker: record.ticker,
          event_type: 'name_changed',
          details: {
            previous: existing.name,
            current: record.name,
            actor: actor.type,
            at: now
          }
        });
      }
      record.aliases.forEach((alias) => aliasSet.add(alias));
      payloadRow.aliases = Array.from(aliasSet);

      const comparableKeys = ['exchange', 'status', 'country', 'currency', 'sector', 'industry', 'listed_at', 'delisted_at', 'source'];
      comparableKeys.forEach((key) => {
        const previous = existing[key];
        const next = (payloadRow as Record<string, unknown>)[key];
        if (previous === next) return;
        const prevString = previous === null || previous === undefined ? null : String(previous);
        const nextString = next === null || next === undefined ? null : String(next);
        if (prevString === nextString) return;
        changeDetected = true;
        events.push({
          ticker: record.ticker,
          event_type: `${key}_updated`,
          details: {
            previous,
            current: next,
            actor: actor.type,
            at: now
          }
        });
      });

      const previousName = existing.name ?? null;
      const nextName = record.name ?? null;
      if (previousName !== nextName) {
        changeDetected = true;
      }

      if (!changeDetected) {
        unchanged.push(record.ticker);
      } else {
        updated.push(record.ticker);
      }
    }

    upserts.push(payloadRow);
  });

  let markedDelisted: string[] = [];
  if (markMissing && exchange) {
    const { data: exchangeRows, error: exchangeError } = await supabaseAdmin
      .from('tickers')
      .select('ticker, status, delisted_at')
      .eq('exchange', exchange);
    if (exchangeError) {
      console.error('tickers-refresh exchange fetch error', exchangeError);
      return jsonResponse(500, { error: 'Failed to evaluate exchange roster', details: exchangeError.message });
    }
    const payloadSet = new Set(tickerList);
    const delistUpdates: any[] = [];
    exchangeRows?.forEach((row) => {
      const ticker = normalizeTicker(row.ticker);
      if (!ticker) return;
      if (payloadSet.has(ticker)) return;
      if (row.status === 'delisted' && row.delisted_at) return;
      markedDelisted.push(ticker);
      delistUpdates.push({
        ticker,
        status: 'delisted',
        delisted_at: now.slice(0, 10),
        last_seen_at: now,
        updated_at: now
      });
      events.push({
        ticker,
        event_type: 'delisted_inferred',
        details: {
          exchange,
          actor: actor.type,
          at: now
        }
      });
    });
    if (delistUpdates.length && !dryRun) {
      const { error: delistError } = await supabaseAdmin.from('tickers').upsert(delistUpdates, { onConflict: 'ticker' });
      if (delistError) {
        console.error('tickers-refresh delist upsert error', delistError);
        return jsonResponse(500, { error: 'Failed to mark missing tickers as delisted', details: delistError.message });
      }
    }
  }

  if (!dryRun) {
    const { error: upsertError } = await supabaseAdmin.from('tickers').upsert(upserts, { onConflict: 'ticker' });
    if (upsertError) {
      console.error('tickers-refresh upsert error', upsertError);
      return jsonResponse(500, { error: 'Failed to upsert tickers', details: upsertError.message });
    }

    if (events.length) {
      const batches = [];
      const batchSize = 500;
      for (let index = 0; index < events.length; index += batchSize) {
        batches.push(events.slice(index, index + batchSize));
      }
      for (const batch of batches) {
        const { error: eventError } = await supabaseAdmin.from('ticker_events').insert(batch);
        if (eventError) {
          console.error('tickers-refresh event insert error', eventError);
        }
      }
    }
  }

  return jsonResponse(200, {
    actor: actor.type,
    dry_run: dryRun,
    total_records: sanitised.length,
    created,
    updated,
    unchanged,
    marked_delisted: markedDelisted,
    exchange,
    source
  });
});

