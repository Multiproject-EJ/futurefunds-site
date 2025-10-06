import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type CacheRecord = {
  id: string;
  cache_key: string;
  prompt_hash: string;
  response_body: Record<string, unknown>;
  usage: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  expires_at: string | null;
};

const encoder = new TextEncoder();
const DEFAULT_CACHE_TTL_MINUTES = 10080; // 7 days

function normaliseScope(scope: string) {
  return scope
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'CACHE';
}

export function resolveCacheTtlMinutes(scope: string, fallback = DEFAULT_CACHE_TTL_MINUTES) {
  const stageKey = `${normaliseScope(scope)}_CACHE_TTL_MINUTES`;
  const stageValue = Deno.env.get(stageKey);
  const globalValue = Deno.env.get('AI_CACHE_TTL_MINUTES');
  for (const candidate of [stageValue, globalValue]) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) {
      return Math.round(num);
    }
  }
  return fallback;
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const helper = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'number') return Number.isFinite(input) ? String(input) : 'null';
    if (typeof input === 'boolean') return input ? 'true' : 'false';
    if (typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'bigint') return JSON.stringify(input.toString());
    if (typeof input === 'undefined') return 'null';

    if (Array.isArray(input)) {
      return `[${input.map((entry) => helper(entry)).join(',')}]`;
    }

    if (typeof input === 'object') {
      if (seen.has(input as object)) {
        throw new TypeError('Cannot stringify circular structure');
      }
      seen.add(input as object);
      const entries = Object.keys(input as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${helper((input as Record<string, unknown>)[key])}`);
      seen.delete(input as object);
      return `{${entries.join(',')}}`;
    }

    return 'null';
  };

  return helper(value);
}

export async function hashRequestBody(body: Record<string, unknown>) {
  const normalised = stableStringify(body ?? {});
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalised));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildCacheKey(parts: string[]) {
  return parts
    .map((part) =>
      String(part ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9:_\-]+/g, '')
    )
    .filter(Boolean)
    .join(':')
    .slice(0, 240);
}

export async function fetchCachedCompletion(
  client: SupabaseClient,
  modelSlug: string,
  cacheKey: string
): Promise<CacheRecord | null> {
  const { data, error } = await client
    .from('cached_completions')
    .select('id, cache_key, prompt_hash, response_body, usage, context, expires_at')
    .eq('model_slug', modelSlug)
    .eq('cache_key', cacheKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    await client.from('cached_completions').delete().eq('id', data.id);
    return null;
  }
  return data as CacheRecord;
}

export async function markCachedCompletionHit(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from('cached_completions')
    .select('hit_count')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return;
  const nextCount = Number(data.hit_count ?? 0) + 1;
  await client
    .from('cached_completions')
    .update({ hit_count: nextCount, last_hit_at: new Date().toISOString() })
    .eq('id', id);
}

export async function storeCachedCompletion(
  client: SupabaseClient,
  modelSlug: string,
  cacheKey: string,
  promptHash: string,
  requestBody: Record<string, unknown>,
  responseBody: Record<string, unknown>,
  usage: Record<string, unknown> | null,
  options: { ttlMinutes?: number; context?: Record<string, unknown> | null; tags?: string[] } = {}
) {
  const ttl = options.ttlMinutes ?? resolveCacheTtlMinutes(modelSlug);
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 60_000).toISOString() : null;

  await client
    .from('cached_completions')
    .upsert(
      {
        model_slug: modelSlug,
        cache_key: cacheKey,
        prompt_hash: promptHash,
        request_body: requestBody,
        response_body: responseBody,
        usage,
        context: options.context ?? null,
        tags: options.tags ?? [],
        hit_count: 0,
        last_hit_at: null,
        expires_at: expiresAt
      },
      { onConflict: 'model_slug,cache_key' }
    );
}

