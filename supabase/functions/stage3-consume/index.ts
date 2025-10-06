import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  resolveModel,
  resolveCredential,
  computeUsageCost,
  requestChatCompletion,
  requestEmbedding,
  withRetry
} from '../_shared/ai.ts';
import {
  hashRequestBody,
  buildCacheKey,
  fetchCachedCompletion,
  storeCachedCompletion,
  markCachedCompletionHit,
  resolveCacheTtlMinutes
} from '../_shared/cache.ts';
import {
  validateStage3QuestionResponse,
  validateStage3SummaryResponse,
  explainValidation
} from '../_shared/prompt-validators.ts';
import { recordErrorLog } from '../_shared/observability.ts';
import {
  applyRequestSettings,
  getStageConfig,
  unpackRetrySettings
} from '../_shared/model-config.ts';
import { loadPromptTemplate, renderTemplate } from '../_shared/prompt-loader.ts';
import { resolveServiceAuth } from '../_shared/service-auth.ts';
import {
  blendDimensionSummaries,
  loadDimensionFactorMap,
  loadTickerFactorSnapshots,
  type FactorLink,
  type FactorSnapshot,
  type EnsembleSummary
} from '../_shared/ensembles.ts';
import { dispatchHighConvictionAlerts } from '../_shared/notifications.ts';

type JsonRecord = Record<string, unknown>;

type Stage3Result = {
  ticker: string;
  verdict: string | null;
  summary: string;
  updated_at: string;
  status: 'ok' | 'failed';
  retrieval?: {
    hits: number;
    citations: RetrievedCitation[];
  };
  cache_hit?: boolean;
};

type Stage3Metrics = {
  finalists: number;
  pending: number;
  completed: number;
  failed: number;
  spend?: number;
};

type DimensionDefinition = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  stage: number;
  order_index: number;
  weight: number;
  color_bad?: string | null;
  color_neutral?: string | null;
  color_good?: string | null;
};

type QuestionDefinition = {
  id: string;
  slug: string;
  stage: number;
  order_index: number;
  prompt: string;
  guidance?: string | null;
  weight: number;
  answer_schema?: JsonRecord | null;
  depends_on: string[];
  tags: string[];
  dimension: DimensionDefinition;
};

type QuestionOutcome = {
  definition: QuestionDefinition;
  verdict: 'bad' | 'neutral' | 'good';
  score: number | null;
  summary: string;
  tags: string[];
  color: string;
  raw: JsonRecord;
};

type RetrievedSnippet = {
  ref: string;
  chunk: string;
  source_type: string | null;
  title: string | null;
  published_at: string | null;
  source_url: string | null;
  similarity: number | null;
  token_length: number;
};

type RetrievedCitation = {
  ref: string;
  title: string | null;
  source_type: string | null;
  published_at: string | null;
  source_url: string | null;
  similarity: number | null;
};

const DEFAULT_SCHEMA = {
  question: 'slug',
  verdict: 'bad|neutral|good',
  score: { type: 'number', min: 0, max: 100 },
  summary: 'string',
  signals: [],
  tags: []
};

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

const stageDefaults = getStageConfig('stage3');
const DEFAULT_STAGE3_MODEL = stageDefaults?.default_model ?? 'openrouter/gpt-5-preview';
const FALLBACK_STAGE3_MODEL = stageDefaults?.fallback_model ?? 'openrouter/gpt-5-mini';
const EMBEDDING_MODEL_SLUG = stageDefaults?.embedding_model ?? 'openai/text-embedding-3-small';
const stageRequestSettings = stageDefaults?.request ?? null;
const stageRetry = unpackRetrySettings(stageDefaults?.retry);
const stageCacheTtlMinutes = resolveCacheTtlMinutes('stage3');
const questionCacheTtlMinutes = resolveCacheTtlMinutes('stage3_question', stageCacheTtlMinutes);
const summaryCacheTtlMinutes = resolveCacheTtlMinutes('stage3_summary', stageCacheTtlMinutes);
const questionSystemTemplate = loadPromptTemplate('stage3/question-system');
const questionUserTemplate = loadPromptTemplate('stage3/question-user');
const summarySystemTemplate = loadPromptTemplate('stage3/summary-system');
const summaryUserTemplate = loadPromptTemplate('stage3/summary-user');
const MAX_RETRIEVAL_SNIPPETS = 8;

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function asNumber(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

async function computeMetrics(client: ReturnType<typeof createClient>, runId: string): Promise<Stage3Metrics> {
  const { data, error } = await client.rpc('run_stage3_summary', { p_run_id: runId }).maybeSingle();
  if (error) throw error;
  return {
    finalists: Number(data?.total_finalists ?? data?.finalists ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0)
  };
}

function parsePlannerNotes(raw: unknown): JsonRecord {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as JsonRecord;
    } catch (error) {
      console.warn('Failed to parse planner notes JSON', error);
      return {};
    }
  }
  if (typeof raw === 'object') {
    return (raw as JsonRecord) ?? {};
  }
  return {};
}

function extractStageConfig(notes: JsonRecord, stageKey: string) {
  const planner = (notes?.planner ?? {}) as JsonRecord;
  const stage = (planner?.[stageKey] ?? {}) as JsonRecord;
  return {
    model: typeof stage?.model === 'string' ? stage.model : null,
    credentialId: typeof stage?.credentialId === 'string' ? stage.credentialId : null
  };
}

async function fetchTickerMeta(client: ReturnType<typeof createClient>, ticker: string) {
  const { data } = await client
    .from('tickers')
    .select('name, exchange, country, sector, industry')
    .eq('ticker', ticker)
    .maybeSingle();
  return data ?? {};
}

async function fetchStageAnswer(
  client: ReturnType<typeof createClient>,
  runId: string,
  ticker: string,
  stage: number
): Promise<JsonRecord | null> {
  const { data } = await client
    .from('answers')
    .select('answer_json')
    .eq('run_id', runId)
    .eq('ticker', ticker)
    .eq('stage', stage)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.answer_json ?? null) as JsonRecord | null;
}

function snippetsToCitations(snippets: RetrievedSnippet[]): RetrievedCitation[] {
  return snippets.map((snippet) => ({
    ref: snippet.ref,
    title: snippet.title,
    source_type: snippet.source_type,
    published_at: snippet.published_at,
    source_url: snippet.source_url,
    similarity: snippet.similarity
  }));
}

function formatStage1Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 1 output unavailable.';
  const label = answer.label ?? answer.classification;
  const reasons = Array.isArray(answer.reasons) ? answer.reasons : [];
  const formattedReasons = reasons
    .slice(0, 4)
    .map((reason: unknown, index: number) => `${index + 1}. ${String(reason)}`)
    .join('\n');
  return `Stage 1 label: ${label ?? 'n/a'}\n${formattedReasons ? `Key reasons:\n${formattedReasons}` : ''}`.trim();
}

function formatStage2Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 2 verdict unavailable.';
  const verdict = (answer.verdict as JsonRecord | undefined) ?? {};
  const scores = (answer.scores as JsonRecord | undefined) ?? {};
  const lines: string[] = [];
  if (typeof verdict.summary === 'string' && verdict.summary.trim()) {
    lines.push(`Verdict: ${verdict.summary.trim()}`);
  }
  if (typeof verdict.go_deep !== 'undefined') {
    const goDeep = typeof verdict.go_deep === 'boolean' ? verdict.go_deep : String(verdict.go_deep).toLowerCase() === 'true';
    lines.push(`Go deep: ${goDeep ? 'yes' : 'no'}`);
  }
  for (const [key, value] of Object.entries(scores)) {
    if (!value || typeof value !== 'object') continue;
    const score = (value as JsonRecord).score;
    const rationale = (value as JsonRecord).rationale;
    if (typeof score !== 'undefined' || typeof rationale === 'string') {
      lines.push(`${key}: ${typeof score === 'number' ? `${score}/10` : 'n/a'} – ${rationale ?? 'n/a'}`);
    }
  }
  return lines.length ? lines.join('\n') : 'Stage 2 scores unavailable.';
}

function buildRetrievalQuery(
  ticker: string,
  meta: Record<string, unknown>,
  stage1: JsonRecord | null,
  stage2: JsonRecord | null
) {
  const lines: string[] = [];
  lines.push(`Ticker: ${ticker}`);
  if (meta.name) lines.push(`Name: ${String(meta.name)}`);
  if (meta.exchange) lines.push(`Exchange: ${String(meta.exchange)}`);
  if (meta.country) lines.push(`Country: ${String(meta.country)}`);
  if (meta.sector) lines.push(`Sector: ${String(meta.sector)}`);
  if (meta.industry) lines.push(`Industry: ${String(meta.industry)}`);

  if (stage1?.summary) lines.push(`Stage 1 summary: ${String(stage1.summary)}`);
  const stage1Reasons = Array.isArray(stage1?.reasons)
    ? (stage1?.reasons as unknown[]).slice(0, 4).map((reason) => String(reason))
    : [];
  if (stage1Reasons.length) lines.push(`Stage 1 reasons: ${stage1Reasons.join('; ')}`);

  if (stage2?.verdict && typeof (stage2.verdict as JsonRecord)?.summary === 'string') {
    lines.push(`Stage 2 verdict: ${String((stage2.verdict as JsonRecord).summary)}`);
  }
  if (Array.isArray(stage2?.next_steps) && stage2.next_steps.length) {
    const nextSteps = (stage2.next_steps as unknown[]).slice(0, 3).map((step) => String(step));
    lines.push(`Stage 2 next steps: ${nextSteps.join('; ')}`);
  }

  return lines.join('\n');
}

async function fetchRetrievedSnippets(
  client: ReturnType<typeof createClient>,
  ticker: string,
  query: string,
  options: {
    model: Awaited<ReturnType<typeof resolveModel>> | null;
    credential: Awaited<ReturnType<typeof resolveCredential>> | null;
    limit?: number;
  }
): Promise<{ snippets: RetrievedSnippet[]; citations: RetrievedCitation[]; tokens: number }> {
  if (!query || !query.trim() || !options.model || !options.credential) {
    return { snippets: [], citations: [], tokens: 0 };
  }

  const embeddingResponse = await requestEmbedding(options.model, options.credential, query.slice(0, 6_000));
  const vector = embeddingResponse?.data?.[0]?.embedding as number[] | undefined;
  if (!vector) {
    return { snippets: [], citations: [], tokens: 0 };
  }

  const { data, error } = await client.rpc('match_doc_chunks', {
    query_embedding: vector,
    query_ticker: ticker || null,
    match_limit: Math.max(1, Math.min(options.limit ?? MAX_RETRIEVAL_SNIPPETS, 20))
  });
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const snippets: RetrievedSnippet[] = rows.map((row: Record<string, unknown>, index: number) => {
    const text = String(row.chunk ?? '').trim();
    const truncated = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
    return {
      ref: `D${index + 1}`,
      chunk: truncated,
      source_type: (row.source_type ?? row.source ?? null) as string | null,
      title: (row.title ?? null) as string | null,
      published_at: (row.published_at ?? null) as string | null,
      source_url: (row.source_url ?? null) as string | null,
      similarity: row.similarity != null ? Number(row.similarity) : null,
      token_length: Number(row.token_length ?? 0)
    };
  });

  const usage = (embeddingResponse?.usage ?? {}) as Record<string, unknown>;
  const tokens = Number(usage.total_tokens ?? usage.prompt_tokens ?? 0);

  return {
    snippets,
    citations: snippetsToCitations(snippets),
    tokens: Number.isFinite(tokens) ? tokens : 0
  };
}

function formatDocSnippets(snippets: RetrievedSnippet[]) {
  if (!snippets.length) return 'No external excerpts supplied.';
  return snippets
    .map((snippet) => {
      const parts: string[] = [];
      if (snippet.title) parts.push(snippet.title);
      if (snippet.source_type) parts.push(snippet.source_type);
      if (snippet.published_at) parts.push(new Date(snippet.published_at).toISOString().slice(0, 10));
      const meta = parts.length ? parts.join(' · ') : 'Source metadata unavailable';
      return `[${snippet.ref}] ${snippet.chunk}\nSource: ${meta}${snippet.source_url ? `\nURL: ${snippet.source_url}` : ''}`;
    })
    .join('\n---\n');
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSchema(schema: unknown): JsonRecord {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as JsonRecord;
  }
  return DEFAULT_SCHEMA as JsonRecord;
}

async function fetchQuestionDefinitions(
  client: ReturnType<typeof createClient>,
  stage = 3
): Promise<QuestionDefinition[]> {
  const { data, error } = await client
    .from('analysis_questions')
    .select(
      `id, slug, stage, order_index, prompt, guidance, weight, answer_schema, depends_on, tags, is_active,
      dimension:analysis_dimensions!inner(id, slug, name, description, stage, order_index, weight, color_bad, color_neutral, color_good, is_active)`
    )
    .eq('stage', stage)
    .eq('is_active', true)
    .eq('dimension.is_active', true)
    .order('dimension(order_index)', { ascending: true })
    .order('order_index', { ascending: true });

  if (error) throw error;

  return (data ?? [])
    .filter((row) => row?.dimension?.is_active !== false)
    .map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      stage: Number(row.stage ?? stage),
      order_index: Number(row.order_index ?? 0),
      prompt: String(row.prompt ?? ''),
      guidance: row.guidance ? String(row.guidance) : null,
      weight: Number(row.weight ?? 1),
      answer_schema: normalizeSchema(row.answer_schema ?? null),
      depends_on: normalizeStringArray(row.depends_on),
      tags: normalizeStringArray(row.tags),
      dimension: {
        id: String(row.dimension.id),
        slug: String(row.dimension.slug),
        name: String(row.dimension.name ?? row.dimension.slug ?? ''),
        description: row.dimension.description ?? null,
        stage: Number(row.dimension.stage ?? stage),
        order_index: Number(row.dimension.order_index ?? 0),
        weight: Number(row.dimension.weight ?? 1),
        color_bad: row.dimension.color_bad ?? null,
        color_neutral: row.dimension.color_neutral ?? null,
        color_good: row.dimension.color_good ?? null
      }
    }));
}

function normalizeVerdictValue(value: unknown): 'bad' | 'neutral' | 'good' {
  const text = String(value ?? '').toLowerCase();
  if (!text) return 'neutral';
  if (['bad', 'negative', 'bearish', 'poor', 'weak', 'red'].includes(text)) return 'bad';
  if (['good', 'positive', 'bullish', 'strong', 'green', 'favorable'].includes(text)) return 'good';
  if (['neutral', 'balanced', 'yellow'].includes(text)) return 'neutral';
  if (text.includes('bad') || text.includes('risk') || text.includes('negative')) return 'bad';
  if (text.includes('good') || text.includes('strong') || text.includes('positive')) return 'good';
  return 'neutral';
}

function normalizeScoreValue(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
}

function pickColor(verdict: 'bad' | 'neutral' | 'good', dimension: DimensionDefinition) {
  if (verdict === 'bad') return dimension.color_bad ?? '#c0392b';
  if (verdict === 'good') return dimension.color_good ?? '#27ae60';
  return dimension.color_neutral ?? '#f39c12';
}

function digestDependencies(question: QuestionDefinition, cache: Map<string, QuestionOutcome>): string {
  if (!question.depends_on?.length) return 'No prior dependencies were recorded.';
  const lines: string[] = [];
  question.depends_on.forEach((slug) => {
    const ref = cache.get(slug);
    if (!ref) return;
    lines.push(
      `${slug}: verdict=${ref.verdict} score=${ref.score ?? 'n/a'} — ${ref.summary.slice(0, 220)}`
    );
  });
  if (!lines.length) return 'Dependencies listed but no answers recorded yet.';
  return lines.join('\n');
}

async function buildQuestionPrompt(
  context: { ticker: string; meta: Record<string, unknown>; stage1: string; stage2: string; docs: string },
  question: QuestionDefinition,
  dependencyDigest: string
) {
  const [systemTemplate, userTemplate] = await Promise.all([questionSystemTemplate, questionUserTemplate]);
  const schema = JSON.stringify(question.answer_schema ?? DEFAULT_SCHEMA, null, 2);
  const guidanceBlock = question.guidance ? `Guidance: ${question.guidance}` : '';
  return {
    system: systemTemplate,
    user: renderTemplate(userTemplate, {
      ticker: context.ticker,
      name: String(context.meta.name ?? 'Unknown'),
      exchange: String(context.meta.exchange ?? 'n/a'),
      country: String(context.meta.country ?? 'n/a'),
      sector: String(context.meta.sector ?? 'n/a'),
      industry: String(context.meta.industry ?? 'n/a'),
      stage1: context.stage1,
      stage2: context.stage2,
      docs: context.docs,
      dependencies: dependencyDigest,
      dimension_name: question.dimension.name,
      dimension_slug: question.dimension.slug,
      objective: question.prompt,
      guidance_block: guidanceBlock,
      schema
    })
  };
}

function computeDimensionSummaries(outcomes: QuestionOutcome[]) {
  const map = new Map<string, {
    dimension: DimensionDefinition;
    weightSum: number;
    scoreSum: number;
    scoredWeight: number;
    verdicts: Record<'bad' | 'neutral' | 'good', number>;
    tags: Set<string>;
    summaries: string[];
    details: JsonRecord[];
  }>();

  outcomes.forEach((outcome) => {
    const key = outcome.definition.dimension.id;
    if (!map.has(key)) {
      map.set(key, {
        dimension: outcome.definition.dimension,
        weightSum: 0,
        scoreSum: 0,
        scoredWeight: 0,
        verdicts: { bad: 0, neutral: 0, good: 0 },
        tags: new Set<string>(),
        summaries: [],
        details: []
      });
    }

    const bucket = map.get(key)!;
    const weight = Number(outcome.definition.weight ?? 1) || 1;
    bucket.weightSum += weight;
    bucket.verdicts[outcome.verdict] += 1;
    if (outcome.score != null) {
      bucket.scoreSum += outcome.score * weight;
      bucket.scoredWeight += weight;
    }
    outcome.tags.forEach((tag) => bucket.tags.add(tag));
    if (outcome.summary) {
      bucket.summaries.push(`${outcome.definition.slug}: ${outcome.summary}`);
    }
    bucket.details.push({
      question: outcome.definition.slug,
      verdict: outcome.verdict,
      score: outcome.score,
      weight,
      tags: outcome.tags,
      color: outcome.color,
      summary: outcome.summary,
      answer: outcome.raw
    });
  });

  return Array.from(map.values()).map((bucket) => {
    const avg = bucket.scoredWeight > 0 ? bucket.scoreSum / bucket.scoredWeight : null;
    let verdict: 'bad' | 'neutral' | 'good' = 'neutral';
    if (bucket.verdicts.bad > bucket.verdicts.good && bucket.verdicts.bad >= bucket.verdicts.neutral) {
      verdict = 'bad';
    } else if (bucket.verdicts.good >= bucket.verdicts.bad && bucket.verdicts.good >= bucket.verdicts.neutral) {
      verdict = 'good';
    }
    if (avg != null) {
      if (avg <= 33) verdict = 'bad';
      else if (avg >= 67) verdict = 'good';
    }

    const color = pickColor(verdict, bucket.dimension);

    return {
      dimension: bucket.dimension,
      verdict,
      score: avg != null ? Number(avg.toFixed(2)) : null,
      weight: bucket.weightSum || bucket.dimension.weight || 1,
      color,
      summary: bucket.summaries.slice(0, 4).join(' \n') || '',
      tags: Array.from(bucket.tags),
      details: bucket.details
    };
  });
}

async function buildSummaryPrompt(
  context: { ticker: string; meta: Record<string, unknown>; stage1: string; stage2: string; docs: string },
  dimensionSummaries: EnsembleSummary[]
) {
  const scoreboard = dimensionSummaries.map((entry) => ({
    dimension: entry.dimension.slug,
    name: entry.dimension.name,
    verdict: entry.verdict,
    score: entry.score,
    ensemble_score: entry.ensembleScore ?? entry.score,
    llm_score: entry.llmScore ?? entry.score,
    factor_score: entry.factorScore,
    weight: entry.weight,
    llm_weight: entry.llmWeight,
    factor_weight: entry.factorWeight,
    color: entry.color,
    summary: entry.summary,
    tags: entry.tags,
    factors: entry.factorBreakdown
  }));

  const payload = {
    ticker: context.ticker,
    company: context.meta.name ?? 'Unknown',
    stage1: context.stage1,
    stage2: context.stage2,
    docs: context.docs,
    scoreboard
  };

  const [systemTemplate, userTemplate] = await Promise.all([summarySystemTemplate, summaryUserTemplate]);
  return {
    system: systemTemplate,
    user: renderTemplate(userTemplate, {
      context_json: JSON.stringify(payload, null, 2)
    })
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
    console.error('Missing required environment configuration for stage3-consume');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const limit = clamp(asNumber(payload?.limit, 2), 1, 6);
  const requestedRunId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  const runId = isUuid(requestedRunId) ? requestedRunId : null;
  if (!runId) {
    return jsonResponse(400, { error: 'Invalid or missing run_id' });
  }

  const serviceAuth = resolveServiceAuth(req);
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const accessToken = tokenMatch?.[1]?.trim();

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  if (!serviceAuth.authorized) {
    if (!accessToken) {
      return jsonResponse(401, { error: 'Missing bearer token' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.error('Invalid session token', userError);
      return jsonResponse(401, { error: 'Invalid or expired session token' });
    }

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
      supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
    ]);

    if (profileResult.error) {
      console.error('Failed to load profile', profileResult.error);
    }
    if (membershipResult.error) {
      console.error('Failed to load membership', membershipResult.error);
    }

    const isAdmin = isAdminContext({
      user: userData.user,
      profile: profileResult.data ?? null,
      membership: membershipResult.data ?? null
    });

    if (!isAdmin) {
      return jsonResponse(403, { error: 'Admin privileges required' });
    }
  }

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .select('id, status, stop_requested, notes, watchlist_id')
    .eq('id', runId)
    .maybeSingle();

  if (runError) {
    console.error('Failed to load run', runError);
    return jsonResponse(500, { error: 'Failed to load run' });
  }
  if (!runRow) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  if (runRow.stop_requested) {
    const metrics = await computeMetrics(supabaseAdmin, runRow.id);
    return jsonResponse(409, {
      error: 'Run flagged to stop',
      run_id: runRow.id,
      metrics
    });
  }

  const plannerNotes = parsePlannerNotes(runRow.notes ?? null);
  const stageConfig = extractStageConfig(plannerNotes, 'stage3');

  let modelRecord;
  const desiredModel = stageConfig.model?.trim() || DEFAULT_STAGE3_MODEL;
  try {
    modelRecord = await resolveModel(supabaseAdmin, desiredModel, FALLBACK_STAGE3_MODEL);
  } catch (error) {
    console.error('Stage 3 model configuration error', error);
    return jsonResponse(500, {
      error: 'Stage 3 model not configured',
      details: error instanceof Error ? error.message : String(error)
    });
  }

  let credentialRecord;
  try {
    const provider = modelRecord.provider ?? 'openai';
    const envKeys = provider.toLowerCase() === 'openrouter'
      ? ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']
      : ['OPENAI_API_KEY'];
    credentialRecord = await resolveCredential(supabaseAdmin, {
      credentialId: stageConfig.credentialId,
      provider,
      preferScopes: ['automation', 'editor'],
      allowEnvFallback: true,
      envKeys
    });
  } catch (error) {
    console.error('Stage 3 credential configuration error', error);
    return jsonResponse(500, {
      error: 'Stage 3 credential not configured',
      details: error instanceof Error ? error.message : String(error)
    });
  }

  let questionDefinitions: QuestionDefinition[] = [];
  try {
    questionDefinitions = await fetchQuestionDefinitions(supabaseAdmin, 3);
  } catch (error) {
    console.error('Failed to load Stage 3 question registry', error);
    return jsonResponse(500, { error: 'Failed to load question registry' });
  }

  if (!questionDefinitions.length) {
    console.warn('No active Stage 3 questions configured');
    return jsonResponse(200, {
      run_id: runRow.id,
      processed: 0,
      failed: 0,
      model: modelRecord.slug,
      metrics: await computeMetrics(supabaseAdmin, runRow.id),
      results: [],
      message: 'No Stage 3 questions configured. Add analysis_questions entries to continue.'
    });
  }

  let dimensionFactorMap: Map<string, FactorLink[]> = new Map();
  try {
    dimensionFactorMap = await loadDimensionFactorMap(supabaseAdmin);
  } catch (error) {
    console.warn('Failed to load deterministic factor configuration', error);
    dimensionFactorMap = new Map();
  }

  let embeddingModelRecord: Awaited<ReturnType<typeof resolveModel>> | null = null;
  let embeddingCredentialRecord: Awaited<ReturnType<typeof resolveCredential>> | null = null;
  try {
    embeddingModelRecord = await resolveModel(supabaseAdmin, EMBEDDING_MODEL_SLUG, EMBEDDING_MODEL_SLUG);
  } catch (error) {
    console.warn('Stage 3 retrieval embedding model unavailable', error);
  }

  if (embeddingModelRecord) {
    try {
      embeddingCredentialRecord = await resolveCredential(supabaseAdmin, {
        credentialId: null,
        provider: embeddingModelRecord.provider,
        preferScopes: ['automation', 'rag', 'editor'],
        allowEnvFallback: true,
        envKeys: ['OPENAI_API_KEY']
      });
    } catch (error) {
      console.warn('Stage 3 retrieval embedding credential unavailable', error);
      embeddingCredentialRecord = null;
    }
  }

  const runJsonPrompt = async (
    systemPrompt: string,
    userPrompt: string,
    {
      promptId,
      ticker,
      validator,
      metadata
    }: {
      promptId: string;
      ticker: string;
      validator?: (payload: JsonRecord) => { valid: boolean; errors: string[] };
      metadata?: JsonRecord | null;
    }
  ) => {
    let rawMessage = '{}';
    try {
      const requestBody = applyRequestSettings(
        {
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        },
        stageRequestSettings
      );
      const promptHash = await hashRequestBody(requestBody);
      const scope = cacheScope ?? promptId;
      const cacheKey = buildCacheKey(['stage3', ticker, scope, promptHash]);
      const ttlMinutes = scope === 'stage3-summary' ? summaryCacheTtlMinutes : questionCacheTtlMinutes;

      let cacheHit = false;
      let usage: Record<string, unknown> | null = null;
      let completion: Record<string, unknown> | null = null;

      try {
        const cached = await fetchCachedCompletion(supabaseAdmin, modelRecord.slug, cacheKey);
        if (cached) {
          cacheHit = true;
          usage = cached.usage ?? null;
          completion = cached.response_body ?? null;
          await markCachedCompletionHit(supabaseAdmin, cached.id);
        }
      } catch (error) {
        console.warn('Stage 3 cache lookup failed', error);
      }

      if (!completion) {
        completion = await withRetry(
          stageRetry.attempts,
          stageRetry.backoffMs,
          () => requestChatCompletion(modelRecord, credentialRecord, requestBody),
          { jitter: stageRetry.jitter }
        );
        const completionAny = completion as { usage?: Record<string, unknown> };
        usage = completionAny?.usage ?? null;
        try {
          await storeCachedCompletion(
            supabaseAdmin,
            modelRecord.slug,
            cacheKey,
            promptHash,
            requestBody,
            completion as Record<string, unknown>,
            usage ?? null,
            { ttlMinutes, context: cacheContext ?? metadata ?? undefined }
          );
        } catch (error) {
          console.warn('Stage 3 cache write failed', error);
        }
      }

      const completionAny = completion as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      rawMessage = completionAny?.choices?.[0]?.message?.content ?? '{}';
      let parsed: JsonRecord;
      try {
        parsed = JSON.parse(rawMessage);
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : String(error);
        const logPayload: JsonRecord = { raw_response: rawMessage, parse_error: parseMessage, metadata };
        await recordErrorLog(supabaseAdmin, {
          context: 'stage3-consume',
          message: `Failed to parse model response JSON: ${parseMessage}`,
          runId: runRow.id,
          ticker,
          stage: 3,
          promptId,
          payload: logPayload
        });
        const parseError = new Error(`Failed to parse model response JSON: ${parseMessage}`);
        (parseError as Error & { logPayload?: JsonRecord; logged?: boolean }).logPayload = logPayload;
        (parseError as Error & { logged?: boolean }).logged = true;
        throw parseError;
      }

      if (validator) {
        const validation = validator(parsed);
        if (!validation.valid) {
          const details = explainValidation(validation);
          const logPayload: JsonRecord = {
            raw_response: rawMessage,
            validation_errors: validation.errors,
            parsed,
            metadata
          };
          await recordErrorLog(supabaseAdmin, {
            context: 'stage3-consume',
            message: `Stage 3 schema validation failed: ${details}`,
            runId: runRow.id,
            ticker,
            stage: 3,
            promptId,
            payload: logPayload
          });
          const validationError = new Error(`Stage 3 schema validation failed: ${details}`);
          (validationError as Error & { logPayload?: JsonRecord; logged?: boolean }).logPayload = logPayload;
          (validationError as Error & { logged?: boolean }).logged = true;
          throw validationError;
        }
      }

      const effectiveUsage = cacheHit ? {} : (usage ?? {});
      const { cost, promptTokens, completionTokens } = computeUsageCost(modelRecord, effectiveUsage);
      return { parsed, cost, promptTokens, completionTokens, cacheHit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const basePayload: JsonRecord =
        error && typeof (error as { logPayload?: JsonRecord }).logPayload === 'object'
          ? { ...(error as { logPayload?: JsonRecord }).logPayload }
          : {};
      if (!basePayload.raw_response) {
        basePayload.raw_response = rawMessage;
      }
      if (metadata && !basePayload.metadata) {
        basePayload.metadata = metadata;
      }

      if (!(error as { logged?: boolean }).logged) {
        await recordErrorLog(supabaseAdmin, {
          context: 'stage3-consume',
          message,
          runId: runRow.id,
          ticker,
          stage: 3,
          promptId,
          payload: basePayload
        });
        (error as { logged?: boolean }).logged = true;
      }

      (error as { logPayload?: JsonRecord }).logPayload = basePayload;
      throw error;
    }
  };

  const { data: pending, error: pendingError } = await supabaseAdmin
    .from('run_items')
    .select('ticker, stage, status, spend_est_usd')
    .eq('run_id', runRow.id)
    .eq('status', 'ok')
    .eq('stage2_go_deep', true)
    .lt('stage', 3)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (pendingError) {
    console.error('Failed to load Stage 3 finalists', pendingError);
    return jsonResponse(500, { error: 'Failed to load Stage 3 finalists', details: pendingError.message });
  }

  const items = pending ?? [];
  if (!items.length) {
    const metrics = await computeMetrics(supabaseAdmin, runRow.id);
    const message = metrics.pending === 0
      ? 'Stage 3 complete or no finalists marked go-deep.'
      : 'No eligible Stage 3 finalists pending.';
    return jsonResponse(200, {
      run_id: runRow.id,
      processed: 0,
      failed: 0,
      model: modelRecord.slug,
      metrics,
      results: [],
      message
    });
  }

  const results: Stage3Result[] = [];
  let processed = 0;
  let failures = 0;
  let totalRetrievalHits = 0;
  let totalEmbeddingTokens = 0;
  let cacheHits = 0;

  for (const item of items) {
    const ticker = item.ticker;
    const startedAt = new Date().toISOString();

    try {
      const [meta, stage1Answer, stage2Answer] = await Promise.all([
        fetchTickerMeta(supabaseAdmin, ticker),
        fetchStageAnswer(supabaseAdmin, runRow.id, ticker, 1),
        fetchStageAnswer(supabaseAdmin, runRow.id, ticker, 2)
      ]);

      const retrieval = await fetchRetrievedSnippets(
        supabaseAdmin,
        ticker,
        buildRetrievalQuery(ticker, meta ?? {}, stage1Answer, stage2Answer),
        {
          model: embeddingModelRecord,
          credential: embeddingCredentialRecord,
          limit: MAX_RETRIEVAL_SNIPPETS
        }
      );
      totalRetrievalHits += retrieval.snippets.length;
      totalEmbeddingTokens += retrieval.tokens;

      const context = {
        ticker,
        meta,
        stage1: formatStage1Summary(stage1Answer),
        stage2: formatStage2Summary(stage2Answer),
        docs: formatDocSnippets(retrieval.snippets)
      };

      const questionCache = new Map<string, QuestionOutcome>();
      const outcomes: QuestionOutcome[] = [];
      let totalCost = 0;

      for (const question of questionDefinitions) {
        const dependencyNotes = digestDependencies(question, questionCache);
        const prompt = await buildQuestionPrompt(context, question, dependencyNotes);
        const {
          parsed,
          cost,
          promptTokens,
          completionTokens,
          cacheHit
        } = await runJsonPrompt(
          prompt.system,
          prompt.user,
          {
            promptId: question.slug,
            ticker,
            validator: validateStage3QuestionResponse,
            metadata: {
              question: question.slug,
              dimension: question.dimension.slug,
              depends_on: question.depends_on
            },
            cacheScope: `stage3-question-${question.slug}`,
            cacheContext: {
              retrieval: retrieval.citations,
              dependencies: dependencyNotes,
              context
            }
          }
        );
        totalCost += cost;
        if (cacheHit) {
          cacheHits += 1;
        }

        const verdict = normalizeVerdictValue(
          (parsed as JsonRecord)?.verdict ?? (parsed as JsonRecord)?.rating ?? (parsed as JsonRecord)?.outlook
        );
        const score = normalizeScoreValue(
          (parsed as JsonRecord)?.score ?? (parsed as JsonRecord)?.rating ?? (parsed as JsonRecord)?.numeric_score
        );
        const summary = (() => {
          if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
            return parsed.summary.trim();
          }
          if (typeof parsed.rationale === 'string' && parsed.rationale.trim()) {
            return parsed.rationale.trim().slice(0, 240);
          }
          if (Array.isArray((parsed as JsonRecord).signals) && (parsed as JsonRecord).signals.length) {
            return (parsed as JsonRecord).signals
              .map((signal: unknown) => String(signal))
              .join('; ')
              .slice(0, 240);
          }
          return 'No summary provided.';
        })();
        const tags = Array.from(
          new Set([
            ...question.tags,
            ...normalizeStringArray((parsed as JsonRecord)?.tags ?? null)
          ])
        );
        const color = pickColor(verdict, question.dimension);

        const enrichedAnswer: JsonRecord = {
          ...parsed,
          context_citations: retrieval.citations
        };
        if (cacheHit) {
          enrichedAnswer.cache_hit = true;
        }

        const outcome: QuestionOutcome = {
          definition: question,
          verdict,
          score,
          summary,
          tags,
          color,
          raw: enrichedAnswer
        };

        outcomes.push(outcome);
        questionCache.set(question.slug, outcome);

        await supabaseAdmin
          .from('analysis_question_results')
          .upsert(
            {
              run_id: runRow.id,
              ticker,
              question_id: question.id,
              question_slug: question.slug,
              dimension_id: question.dimension.id,
              stage: question.stage,
              verdict,
              score,
              weight: question.weight,
              color,
              summary,
              answer: enrichedAnswer,
              tags,
              dependencies: question.depends_on,
              created_at: startedAt,
              updated_at: startedAt
            },
            { onConflict: 'run_id,ticker,question_id' }
          );

        await supabaseAdmin.from('answers').insert({
          run_id: runRow.id,
          ticker,
          stage: 3,
          question_group: question.slug,
          answer_json: enrichedAnswer,
          tokens_in: promptTokens,
          tokens_out: completionTokens,
          cost_usd: cost,
          created_at: startedAt
        });

        if (cost > 0) {
          await supabaseAdmin.from('cost_ledger').insert({
            run_id: runRow.id,
            stage: 3,
            model: modelRecord.slug,
            tokens_in: promptTokens,
            tokens_out: completionTokens,
            cost_usd: cost,
            created_at: startedAt
          });
        }
      }

      const baseDimensionSummaries = computeDimensionSummaries(outcomes);
      let snapshotMap: Map<string, FactorSnapshot> = new Map();
      if (dimensionFactorMap.size > 0) {
        try {
          snapshotMap = await loadTickerFactorSnapshots(supabaseAdmin, ticker);
        } catch (error) {
          console.warn(`Failed to load factor snapshots for ${ticker}`, error);
        }
      }
      const dimensionSummaries = blendDimensionSummaries(baseDimensionSummaries, dimensionFactorMap, snapshotMap);

      if (dimensionSummaries.length) {
        await supabaseAdmin
          .from('analysis_dimension_scores')
          .upsert(
            dimensionSummaries.map((entry) => ({
              run_id: runRow.id,
              ticker,
              dimension_id: entry.dimension.id,
              verdict: entry.verdict,
              score: entry.score,
              ensemble_score: entry.ensembleScore ?? entry.score,
              llm_score: entry.llmScore ?? entry.score,
              factor_score: entry.factorScore,
              weight: entry.weight,
              llm_weight: entry.llmWeight,
              factor_weight: entry.factorWeight,
              color: entry.color,
              summary: entry.summary,
              tags: entry.tags,
              details: entry.details,
              factor_breakdown: entry.factorBreakdown,
              created_at: startedAt,
              updated_at: startedAt
            })),
            { onConflict: 'run_id,ticker,dimension_id' }
          );
      }

      const summaryPrompt = await buildSummaryPrompt(context, dimensionSummaries);
      const {
        parsed: summaryJson,
        cost: summaryCost,
        promptTokens: summaryPromptTokens,
        completionTokens: summaryCompletionTokens,
        cacheHit: summaryCacheHit
      } = await runJsonPrompt(summaryPrompt.system, summaryPrompt.user, {
        promptId: 'stage3-summary',
        ticker,
        validator: validateStage3SummaryResponse,
        metadata: {
          ticker,
          question_count: questionDefinitions.length
        },
        cacheScope: 'stage3-summary',
        cacheContext: {
          retrieval: retrieval.citations,
          dimensions: dimensionSummaries
        }
      });
      totalCost += summaryCost;
      if (summaryCacheHit) {
        cacheHits += 1;
      }

      summaryJson.context_citations = retrieval.citations;
      if (summaryCacheHit) {
        summaryJson.cache_hit = true;
      }

      summaryJson.scoreboard = dimensionSummaries.map((entry) => ({
        dimension: entry.dimension.slug,
        name: entry.dimension.name,
        verdict: entry.verdict,
        score: entry.score,
        ensemble_score: entry.ensembleScore ?? entry.score,
        llm_score: entry.llmScore ?? entry.score,
        factor_score: entry.factorScore,
        weight: entry.weight,
        llm_weight: entry.llmWeight,
        factor_weight: entry.factorWeight,
        color: entry.color,
        summary: entry.summary,
        tags: entry.tags,
        factors: entry.factorBreakdown
      }));

      const thesisText =
        typeof summaryJson.thesis === 'string'
          ? summaryJson.thesis
          : typeof summaryJson.narrative === 'string'
            ? summaryJson.narrative
            : null;

      await supabaseAdmin.from('answers').insert({
        run_id: runRow.id,
        ticker,
        stage: 3,
        question_group: 'summary',
        answer_json: summaryJson,
        answer_text: thesisText,
        tokens_in: summaryPromptTokens,
        tokens_out: summaryCompletionTokens,
        cost_usd: summaryCost,
        created_at: startedAt
      });

      if (summaryCost > 0) {
        await supabaseAdmin.from('cost_ledger').insert({
          run_id: runRow.id,
          stage: 3,
          model: modelRecord.slug,
          tokens_in: summaryPromptTokens,
          tokens_out: summaryCompletionTokens,
          cost_usd: summaryCost,
          created_at: startedAt
        });
      }

      await supabaseAdmin
        .from('run_items')
        .update({
          stage: 3,
          status: 'ok',
          spend_est_usd: Number(item.spend_est_usd ?? 0) + totalCost,
          updated_at: new Date().toISOString()
        })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      const runLabel = (() => {
        const planner = (plannerNotes?.planner ?? {}) as JsonRecord;
        if (typeof planner?.label === 'string' && planner.label.trim()) return planner.label.trim();
        if (typeof planner?.name === 'string' && planner.name.trim()) return planner.name.trim();
        const scope = (planner?.scope ?? {}) as JsonRecord;
        if (typeof scope?.label === 'string' && scope.label.trim()) return scope.label.trim();
        if (typeof scope?.name === 'string' && scope.name.trim()) return scope.name.trim();
        return null;
      })();

      try {
        await dispatchHighConvictionAlerts(supabaseAdmin, {
          runId: runRow.id,
          watchlistId: typeof runRow.watchlist_id === 'string' ? runRow.watchlist_id : null,
          ticker,
          company: typeof meta?.name === 'string' ? meta.name : null,
          verdict:
            typeof summaryJson.verdict === 'string'
              ? summaryJson.verdict
              : typeof summaryJson.rating === 'string'
                ? summaryJson.rating
                : typeof summaryJson.outlook === 'string'
                  ? summaryJson.outlook
                  : null,
          conviction:
            typeof summaryJson.conviction === 'string'
              ? summaryJson.conviction
              : typeof summaryJson.confidence === 'string'
                ? summaryJson.confidence
                : null,
          summaryText: thesisText ?? (typeof summaryJson.summary === 'string' ? summaryJson.summary : null),
          dimensionSummaries,
          stage3Summary: summaryJson,
          runLabel
        });
      } catch (error) {
        console.warn(`Notification dispatch failed for ${ticker}`, error);
      }

      results.push({
        ticker,
        verdict: typeof summaryJson.verdict === 'string' ? summaryJson.verdict : summaryJson.rating?.toString() ?? null,
        summary: thesisText ?? (typeof summaryJson.summary === 'string' ? summaryJson.summary : '—'),
        updated_at: startedAt,
        status: 'ok',
        retrieval: {
          hits: retrieval.snippets.length,
          citations: retrieval.citations
        },
        cache_hit: summaryCacheHit
      });
      processed += 1;
    } catch (error) {
      console.error(`Stage 3 processing failed for ${ticker}`, error);
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);

      const basePayload: JsonRecord =
        error && typeof (error as { logPayload?: JsonRecord }).logPayload === 'object'
          ? { ...(error as { logPayload?: JsonRecord }).logPayload }
          : {};
      if (!(error as { logged?: boolean }).logged) {
        if (!basePayload.ticker) basePayload.ticker = ticker;
        basePayload.run_item = {
          status: item.status,
          stage: item.stage,
          spend_est_usd: item.spend_est_usd
        };
        await recordErrorLog(supabaseAdmin, {
          context: 'stage3-consume',
          message,
          runId: runRow.id,
          ticker,
          stage: 3,
          promptId: 'stage3-run',
          payload: basePayload,
          metadata: {
            planner_model: stageConfig.model,
            planner_credential: stageConfig.credentialId
          }
        });
        (error as { logged?: boolean }).logged = true;
      }

      await supabaseAdmin
        .from('run_items')
        .update({ stage: 3, status: 'failed', updated_at: new Date().toISOString() })
        .eq('run_id', runRow.id)
        .eq('ticker', ticker);

      results.push({
        ticker,
        verdict: null,
        summary: message,
        updated_at: new Date().toISOString(),
        status: 'failed'
      });
    }
  }

  const metrics = await computeMetrics(supabaseAdmin, runRow.id);
  let spend = 0;
  try {
    const { data: breakdown } = await supabaseAdmin.rpc('run_cost_breakdown', { p_run_id: runRow.id });
    if (Array.isArray(breakdown)) {
      spend = breakdown
        .filter((row: any) => Number(row.stage) === 3)
        .reduce((acc: number, row: any) => acc + Number(row.cost_usd ?? 0), 0);
    }
  } catch (error) {
    console.error('Failed to compute Stage 3 spend', error);
  }
  const metricsWithSpend: Stage3Metrics = { ...metrics, spend };

  const cacheNote = cacheHits > 0 ? ` (${cacheHits} cached)` : '';
  const message = processed > 0
    ? `Processed ${processed} finalist${processed === 1 ? '' : 's'}${cacheNote}. Pending deep dives: ${metrics.pending}.`
    : 'No finalists processed.';

  return jsonResponse(200, {
    run_id: runRow.id,
    processed,
    failed: failures,
    model: modelRecord.slug,
    metrics: metricsWithSpend,
    results,
    message,
    cache_hits: cacheHits,
    retrieval: {
      total_hits: totalRetrievalHits,
      embedding_tokens: totalEmbeddingTokens
    }
  });
});
