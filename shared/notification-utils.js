const CONVICTION_ORDER = {
  very_high: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0
};

export function normalizeSummary(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? text : null;
  }
  return null;
}

export function normalizeConviction(value) {
  if (typeof value !== 'string') {
    return { level: 'unknown', text: null };
  }
  const text = value.trim();
  if (!text) {
    return { level: 'unknown', text: null };
  }
  const normalized = text.toLowerCase();
  if (normalized.includes('very high')) {
    return { level: 'very_high', text };
  }
  if (normalized.includes('high')) {
    return { level: 'high', text };
  }
  if (normalized.includes('medium') || normalized.includes('moderate')) {
    return { level: 'medium', text };
  }
  if (normalized.includes('low')) {
    return { level: 'low', text };
  }
  return { level: 'unknown', text };
}

export function clampScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Number(num.toFixed(2));
}

export function computeEnsembleScore(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  let weighted = 0;
  let totalWeight = 0;
  for (const entry of entries) {
    const score = clampScore(entry?.ensembleScore ?? entry?.score ?? null);
    if (score == null) continue;
    const weight = Number.isFinite(entry?.weight) ? Number(entry.weight) : 1;
    if (weight <= 0) continue;
    weighted += score * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return Number((weighted / totalWeight).toFixed(2));
}

export function compareConvictionLevel(a, b) {
  const scoreA = CONVICTION_ORDER[a] ?? 0;
  const scoreB = CONVICTION_ORDER[b] ?? 0;
  return scoreA - scoreB;
}

export { CONVICTION_ORDER };
