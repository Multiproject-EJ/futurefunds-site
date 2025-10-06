// /assets/ai-registry.js
// Shared helpers for loading AI model and credential metadata from Supabase.

import { supabase } from './supabase.js';

export function parseScopes(scopes) {
  if (!scopes) return [];
  if (Array.isArray(scopes)) return scopes.map((s) => String(s)).filter(Boolean);
  if (typeof scopes === 'string') {
    return scopes
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (typeof scopes === 'object') {
    return Object.values(scopes)
      .flatMap((value) => parseScopes(value))
      .filter(Boolean);
  }
  return [];
}

function normalizeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export async function fetchActiveModels({ includeInactive = false } = {}) {
  let query = supabase
    .from('ai_model_profiles')
    .select('slug, label, provider, tier, price_in, price_out, notes, is_active')
    .order('tier', { ascending: true })
    .order('label', { ascending: true });

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => ({
    slug: row.slug,
    label: row.label,
    provider: row.provider,
    tier: row.tier ?? 'standard',
    price_in: normalizeNumber(row.price_in),
    price_out: normalizeNumber(row.price_out),
    notes: row.notes ?? null,
    is_active: row.is_active !== false
  }));
}

export async function fetchActiveCredentials({ includeInactive = false, scope = null } = {}) {
  let query = supabase
    .from('editor_api_credentials')
    .select('id, label, provider, tier, scopes, is_active, updated_at')
    .order('updated_at', { ascending: false });

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  if (scope) {
    query = query.contains('scopes', [scope]);
  }

  const { data, error } = await query;
  if (error) throw error;
  const seen = new Map();

  (data ?? []).forEach((row) => {
    if (!row?.id || seen.has(row.id)) return;
    seen.set(row.id, {
      id: row.id,
      label: row.label ?? 'Unnamed credential',
      provider: row.provider,
      tier: row.tier ?? 'standard',
      scopes: parseScopes(row.scopes),
      is_active: row.is_active !== false,
      updated_at: row.updated_at ?? null
    });
  });

  return Array.from(seen.values());
}

export function buildModelMap(models = []) {
  const map = new Map();
  models.forEach((model) => {
    map.set(model.slug, model);
  });
  return map;
}

export function buildPriceMap(models = []) {
  const prices = new Map();
  models.forEach((model) => {
    prices.set(model.slug, {
      in: normalizeNumber(model.price_in),
      out: normalizeNumber(model.price_out)
    });
  });
  return prices;
}

export function formatModelOption(model) {
  if (!model) return 'Unknown model';
  const tier = model.tier ? model.tier.replace(/_/g, ' ') : '';
  const providerLabel = model.provider ? model.provider.toUpperCase() : '';
  const parts = [model.label];
  if (tier && tier.toLowerCase() !== 'standard') {
    parts.push(`• ${tier}`);
  }
  if (providerLabel) {
    parts.push(`• ${providerLabel}`);
  }
  return parts.join(' ');
}

export function formatCredentialOption(credential) {
  if (!credential) return 'Unknown credential';
  const tier = credential.tier ? credential.tier.replace(/_/g, ' ') : '';
  const scopes = (credential.scopes || []).join(', ');
  const parts = [credential.label || credential.id];
  if (tier && tier.toLowerCase() !== 'standard') {
    parts.push(`• ${tier}`);
  }
  if (credential.provider) {
    parts.push(`• ${credential.provider.toUpperCase()}`);
  }
  if (scopes) {
    parts.push(`• ${scopes}`);
  }
  return parts.join(' ');
}
