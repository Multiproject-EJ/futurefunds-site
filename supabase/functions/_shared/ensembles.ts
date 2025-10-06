import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type FactorDefinition = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  direction: 'higher_better' | 'lower_better';
  scale_min?: number | null;
  scale_max?: number | null;
  weight?: number | null;
  metadata?: JsonValue;
};

export type FactorLink = {
  dimension_id: string;
  weight: number;
  factor: FactorDefinition;
};

export type FactorSnapshot = {
  factor_id: string;
  value: number | null;
  score: number | null;
  as_of: string | null;
  source: string | null;
  notes: string | null;
  metadata: JsonValue;
};

type DimensionSummary = {
  dimension: {
    id: string;
    slug: string;
    name: string;
    color_bad?: string | null;
    color_neutral?: string | null;
    color_good?: string | null;
    weight?: number | null;
  };
  verdict: 'bad' | 'neutral' | 'good';
  score: number | null;
  weight: number;
  color: string;
  summary: string;
  tags: string[];
  details: JsonValue;
};

export type EnsembleSummary = DimensionSummary & {
  llmScore: number | null;
  llmWeight: number;
  factorScore: number | null;
  factorWeight: number;
  factorBreakdown: {
    slug: string;
    name: string;
    score: number;
    value: number | null;
    weight: number;
    as_of: string | null;
    direction: 'higher_better' | 'lower_better';
    source: string | null;
    notes: string | null;
    scale_min: number | null;
    scale_max: number | null;
    metadata: JsonValue;
  }[];
  ensembleScore: number | null;
};

type GenericClient = SupabaseClient<any, any, any>;

type FactorLinkRow = {
  dimension_id: string;
  weight: number | null;
  factor: {
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    category?: string | null;
    direction: 'higher_better' | 'lower_better';
    scale_min?: number | null;
    scale_max?: number | null;
    weight?: number | null;
    metadata?: JsonValue;
  } | null;
};

type FactorSnapshotRow = {
  factor_id: string;
  value: number | null;
  score: number | null;
  as_of: string | null;
  source: string | null;
  notes: string | null;
  metadata: JsonValue | null;
};

function clampScore(score: unknown): number | null {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Number(num.toFixed(2));
}

function normalizeWeight(value: unknown, fallback = 1, allowZero = false): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return fallback;
  if (num === 0 && !allowZero) return fallback;
  return Number(num.toFixed(4));
}

function computeSnapshotScore(snapshot: FactorSnapshotRow, factor: FactorDefinition): number | null {
  const direct = clampScore(snapshot.score);
  if (direct != null) return direct;
  const value = Number(snapshot.value);
  if (!Number.isFinite(value)) return null;

  const min = factor.scale_min != null ? Number(factor.scale_min) : null;
  const max = factor.scale_max != null ? Number(factor.scale_max) : null;
  if (min != null && max != null && Number.isFinite(min) && Number.isFinite(max) && max !== min) {
    const span = max - min;
    const clamped = Math.max(Math.min(value, Math.max(min, max)), Math.min(min, max));
    let ratio = span === 0 ? 0.5 : (clamped - min) / span;
    ratio = Math.max(0, Math.min(1, ratio));
    if (factor.direction === 'lower_better') {
      ratio = 1 - ratio;
    }
    return Number((ratio * 100).toFixed(2));
  }

  const metadata = (factor.metadata ?? {}) as Record<string, JsonValue>;
  const ideal = metadata?.ideal != null ? Number(metadata.ideal) : null;
  const tolerance = metadata?.tolerance != null ? Number(metadata.tolerance) : null;
  if (ideal != null && Number.isFinite(ideal)) {
    const spread = tolerance && Number.isFinite(tolerance) && tolerance > 0 ? tolerance : Math.max(Math.abs(ideal) || 1, 0.0001);
    let distance = Math.abs(value - ideal);
    if (factor.direction === 'lower_better' && value <= ideal) {
      return 100;
    }
    const ratio = Math.max(0, Math.min(1, 1 - distance / (spread * 2)));
    if (factor.direction === 'lower_better') {
      return Number((ratio * 100).toFixed(2));
    }
    return Number((ratio * 100).toFixed(2));
  }

  return null;
}

function deriveLlmScore(summary: DimensionSummary): number {
  if (summary.score != null) {
    const value = clampScore(summary.score);
    if (value != null) return value;
  }
  if (summary.verdict === 'good') return 80;
  if (summary.verdict === 'bad') return 20;
  return 50;
}

function cloneMetadata(value: JsonValue | null | undefined): JsonValue {
  if (value == null) return {};
  if (Array.isArray(value)) {
    return value.map((item) => cloneMetadata(item as JsonValue)) as JsonValue;
  }
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, JsonValue>)) {
      output[key] = cloneMetadata(entry);
    }
    return output;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value) : null;
  }
  return value as JsonValue;
}

function metadataToRecord(value: JsonValue | null | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, JsonValue>;
}

export async function loadDimensionFactorMap(client: GenericClient): Promise<Map<string, FactorLink[]>> {
  const { data, error } = await client
    .from('dimension_factor_links')
    .select('dimension_id, weight, factor:scoring_factors(id, slug, name, description, category, direction, scale_min, scale_max, weight, metadata)');
  if (error) throw error;
  const map = new Map<string, FactorLink[]>();
  (data ?? []).forEach((row: FactorLinkRow) => {
    if (!row.factor || !row.factor.id) return;
    const entry: FactorLink = {
      dimension_id: row.dimension_id,
      weight: normalizeWeight(row.weight, 1, true),
      factor: {
        id: row.factor.id,
        slug: row.factor.slug,
        name: row.factor.name,
        description: row.factor.description ?? null,
        category: row.factor.category ?? null,
        direction: row.factor.direction ?? 'higher_better',
        scale_min: row.factor.scale_min != null ? Number(row.factor.scale_min) : null,
        scale_max: row.factor.scale_max != null ? Number(row.factor.scale_max) : null,
        weight: row.factor.weight != null ? Number(row.factor.weight) : 1,
        metadata: cloneMetadata(row.factor.metadata ?? {})
      }
    };
    if (!map.has(entry.dimension_id)) {
      map.set(entry.dimension_id, []);
    }
    map.get(entry.dimension_id)!.push(entry);
  });
  return map;
}

export async function loadTickerFactorSnapshots(client: GenericClient, ticker: string): Promise<Map<string, FactorSnapshot>> {
  const { data, error } = await client
    .from('ticker_factor_latest')
    .select('factor_id, value, score, as_of, source, notes, metadata')
    .eq('ticker', ticker);
  if (error) throw error;
  const map = new Map<string, FactorSnapshot>();
  (data ?? []).forEach((row: FactorSnapshotRow) => {
    if (!row.factor_id) return;
    map.set(row.factor_id, {
      factor_id: row.factor_id,
      value: row.value != null && Number.isFinite(Number(row.value)) ? Number(row.value) : null,
      score: row.score != null && Number.isFinite(Number(row.score)) ? Number(row.score) : null,
      as_of: row.as_of ?? null,
      source: row.source ?? null,
      notes: row.notes ?? null,
      metadata: cloneMetadata(row.metadata ?? {})
    });
  });
  return map;
}

export function blendDimensionSummaries(
  summaries: DimensionSummary[],
  factorMap: Map<string, FactorLink[]>,
  snapshotMap: Map<string, FactorSnapshot>
): EnsembleSummary[] {
  return summaries.map((summary) => {
    const llmScore = deriveLlmScore(summary);
    const llmWeight = normalizeWeight(summary.weight, 1, true);
    const links = factorMap.get(summary.dimension.id) ?? [];
    const contributions: EnsembleSummary['factorBreakdown'] = [];
    let factorWeightedSum = 0;
    let factorWeight = 0;

    links.forEach((link) => {
      const snapshot = snapshotMap.get(link.factor.id);
      if (!snapshot) return;
      const score = computeSnapshotScore(snapshot, link.factor);
      if (score == null) return;
      const factorWeightComponent =
        normalizeWeight(link.weight, 1, true) * normalizeWeight(link.factor.weight ?? 1, 1, true);
      if (factorWeightComponent <= 0) return;
      factorWeightedSum += score * factorWeightComponent;
      factorWeight += factorWeightComponent;
      contributions.push({
        slug: link.factor.slug,
        name: link.factor.name,
        score: Number(score.toFixed(2)),
        value: snapshot.value,
        weight: Number(factorWeightComponent.toFixed(4)),
        as_of: snapshot.as_of,
        direction: link.factor.direction,
        source: snapshot.source,
        notes: snapshot.notes,
        scale_min: link.factor.scale_min ?? null,
        scale_max: link.factor.scale_max ?? null,
        metadata: {
          ...metadataToRecord(link.factor.metadata ?? {}),
          ...metadataToRecord(snapshot.metadata)
        }
      });
    });

    const factorScore = factorWeight > 0 ? Number((factorWeightedSum / factorWeight).toFixed(2)) : null;
    let ensembleScore = llmScore;
    if (factorScore != null && factorWeight > 0) {
      ensembleScore = Number(((llmScore * llmWeight + factorScore * factorWeight) / (llmWeight + factorWeight)).toFixed(2));
    }
    const totalWeight = Number((llmWeight + factorWeight).toFixed(4));

    let verdict: 'bad' | 'neutral' | 'good' = summary.verdict;
    if (ensembleScore != null) {
      if (ensembleScore <= 33) verdict = 'bad';
      else if (ensembleScore >= 67) verdict = 'good';
      else verdict = 'neutral';
    }

    const color = verdict === 'good'
      ? summary.dimension.color_good ?? summary.color
      : verdict === 'bad'
        ? summary.dimension.color_bad ?? summary.color
        : summary.dimension.color_neutral ?? summary.color;

    return {
      ...summary,
      weight: totalWeight,
      verdict,
      color,
      score: ensembleScore,
      llmScore,
      llmWeight,
      factorScore,
      factorWeight: Number(factorWeight.toFixed(4)),
      factorBreakdown: contributions,
      ensembleScore
    };
  });
}

