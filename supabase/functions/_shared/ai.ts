import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type AIModel = {
  slug: string;
  label?: string | null;
  provider: string;
  model_name: string;
  base_url?: string | null;
  tier?: string | null;
  price_in?: number | null;
  price_out?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type AICredential = {
  id: string;
  provider: string;
  api_key: string;
  label?: string | null;
  tier?: string | null;
  scopes?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

export type UsageRecord = {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

const DEFAULT_BASE_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1'
};

function asMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseScopes(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .flatMap((entry) => parseScopes(entry))
      .filter(Boolean);
  }
  return [];
}

function normalizeModel(row: Record<string, unknown> | null): AIModel | null {
  if (!row) return null;
  if (row.is_active === false) return null;
  return {
    slug: String(row.slug ?? ''),
    label: typeof row.label === 'string' ? row.label : null,
    provider: String(row.provider ?? 'openai'),
    model_name: String(row.model_name ?? row.slug ?? ''),
    base_url: typeof row.base_url === 'string' ? row.base_url : null,
    tier: typeof row.tier === 'string' ? row.tier : null,
    price_in: typeof row.price_in === 'number' ? row.price_in : Number(row.price_in ?? 0),
    price_out: typeof row.price_out === 'number' ? row.price_out : Number(row.price_out ?? 0),
    metadata: asMetadata(row.metadata)
  };
}

function normalizeCredential(row: Record<string, unknown> | null): AICredential | null {
  if (!row) return null;
  if (row.is_active === false) return null;
  return {
    id: String(row.id ?? ''),
    provider: String(row.provider ?? 'openai'),
    api_key: String(row.api_key ?? ''),
    label: typeof row.label === 'string' ? row.label : null,
    tier: typeof row.tier === 'string' ? row.tier : null,
    scopes: parseScopes(row.scopes),
    metadata: asMetadata(row.metadata)
  };
}

function defaultEnvKeys(provider: string): string[] {
  const key = provider?.toLowerCase();
  if (key === 'openrouter') {
    return ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
  }
  if (key === 'openai') {
    return ['OPENAI_API_KEY'];
  }
  return [];
}

export async function fetchModel(
  client: SupabaseClient,
  slug: string
): Promise<AIModel | null> {
  if (!slug) return null;
  const { data, error } = await client
    .from('ai_model_profiles')
    .select('slug, label, provider, model_name, base_url, tier, price_in, price_out, metadata, is_active')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return normalizeModel(data ?? null);
}

export async function resolveModel(
  client: SupabaseClient,
  slug: string,
  fallbackSlug?: string
): Promise<AIModel> {
  const primary = await fetchModel(client, slug);
  if (primary) return primary;
  if (fallbackSlug) {
    const fallback = await fetchModel(client, fallbackSlug);
    if (fallback) return fallback;
  }
  throw new Error(`Model "${slug || fallbackSlug || 'unknown'}" is not configured`);
}

async function fetchCredentialById(
  client: SupabaseClient,
  credentialId: string,
  provider: string
): Promise<AICredential | null> {
  const { data, error } = await client
    .from('editor_api_credentials')
    .select('id, provider, api_key, label, tier, scopes, metadata, is_active')
    .eq('id', credentialId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return normalizeCredential(data ?? null);
}

async function fetchCredentialByScope(
  client: SupabaseClient,
  provider: string,
  scope: string
): Promise<AICredential | null> {
  const { data, error } = await client
    .from('editor_api_credentials')
    .select('id, provider, api_key, label, tier, scopes, metadata, is_active')
    .eq('provider', provider)
    .eq('is_active', true)
    .contains('scopes', [scope])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return normalizeCredential(data ?? null);
}

function envCredential(provider: string, envKey: string): AICredential | null {
  const value = Deno.env.get(envKey);
  if (!value) return null;
  return {
    id: `env:${envKey}`,
    provider,
    api_key: value,
    label: envKey,
    tier: 'env',
    scopes: ['env'],
    metadata: {}
  };
}

export async function resolveCredential(
  client: SupabaseClient,
  {
    credentialId,
    provider,
    preferScopes = ['automation', 'editor'],
    allowEnvFallback = true,
    envKeys
  }: {
    credentialId?: string | null;
    provider: string;
    preferScopes?: string[];
    allowEnvFallback?: boolean;
    envKeys?: string[];
  }
): Promise<AICredential> {
  const normalizedProvider = provider?.toLowerCase() || 'openai';

  if (credentialId) {
    try {
      const direct = await fetchCredentialById(client, credentialId, normalizedProvider);
      if (direct) return direct;
    } catch (error) {
      console.error('Credential lookup failed', error);
    }
  }

  for (const scope of preferScopes) {
    try {
      const scoped = await fetchCredentialByScope(client, normalizedProvider, scope);
      if (scoped) return scoped;
    } catch (error) {
      console.error(`Credential lookup failed for scope ${scope}`, error);
    }
  }

  if (allowEnvFallback) {
    const candidates = envKeys && envKeys.length ? envKeys : defaultEnvKeys(normalizedProvider);
    for (const key of candidates) {
      const credential = envCredential(normalizedProvider, key);
      if (credential) {
        return credential;
      }
    }
  }

  throw new Error(`No credential configured for provider ${normalizedProvider}`);
}

export function computeUsageCost(model: AIModel, usage: UsageRecord | null | undefined) {
  const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const priceIn = Number(model.price_in ?? 0);
  const priceOut = Number(model.price_out ?? 0);
  const inCost = (promptTokens / 1_000_000) * priceIn;
  const outCost = (completionTokens / 1_000_000) * priceOut;
  return { cost: inCost + outCost, promptTokens, completionTokens };
}

function mergedBaseUrl(model: AIModel, credential: AICredential) {
  const modelMeta = asMetadata(model.metadata);
  const credentialMeta = asMetadata(credential.metadata);
  const candidate =
    (typeof credentialMeta.base_url === 'string' && credentialMeta.base_url) ||
    (typeof modelMeta.base_url === 'string' && modelMeta.base_url) ||
    model.base_url;
  const fallback = DEFAULT_BASE_URL[model.provider?.toLowerCase() ?? 'openai'] || DEFAULT_BASE_URL.openai;
  return (candidate || fallback).replace(/\/$/, '');
}

function buildHeaders(model: AIModel, credential: AICredential) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.api_key}`
  };
  const provider = model.provider?.toLowerCase() ?? 'openai';
  const modelMeta = asMetadata(model.metadata);
  const credentialMeta = asMetadata(credential.metadata);

  if (provider === 'openrouter') {
    const referer = String(credentialMeta.referer ?? modelMeta.referer ?? 'https://futurefunds.ai');
    const title = String(credentialMeta.title ?? modelMeta.title ?? 'FutureFunds Analyst');
    headers['HTTP-Referer'] = referer;
    headers['X-Title'] = title;
  }

  const extraCredentialHeaders = credentialMeta.headers;
  if (extraCredentialHeaders && typeof extraCredentialHeaders === 'object') {
    for (const [key, value] of Object.entries(extraCredentialHeaders)) {
      if (typeof value === 'string' && key) {
        headers[key] = value;
      }
    }
  }

  const extraModelHeaders = modelMeta.headers;
  if (extraModelHeaders && typeof extraModelHeaders === 'object') {
    for (const [key, value] of Object.entries(extraModelHeaders)) {
      if (typeof value === 'string' && key && !headers[key]) {
        headers[key] = value;
      }
    }
  }

  return headers;
}

export async function requestChatCompletion(
  model: AIModel,
  credential: AICredential,
  body: Record<string, unknown>
) {
  const baseUrl = mergedBaseUrl(model, credential);
  const url = `${baseUrl}/chat/completions`;
  const payload = { ...body, model: model.model_name };
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(model, credential),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model request failed (${response.status}): ${text}`);
  }
  return await response.json();
}
