import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  resolveModel,
  resolveCredential,
  requestChatCompletion,
  requestEmbedding,
  computeUsageCost,
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
import { applyRequestSettings, getStageConfig, unpackRetrySettings } from '../_shared/model-config.ts';
import { loadPromptTemplate, renderTemplate } from '../_shared/prompt-loader.ts';
import { recordErrorLog } from '../_shared/observability.ts';
import { resolveServiceAuth } from '../_shared/service-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-automation-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

type JsonRecord = Record<string, unknown>;

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

type FocusResult = {
  id: string;
  ticker: string;
  question: string;
  status: 'answered' | 'failed';
  answer_text: string | null;
  cache_hit: boolean;
  citations: RetrievedCitation[];
  updated_at: string;
};

type FocusMetrics = {
  total_requests: number;
  pending: number;
  completed: number;
  failed: number;
};

const stageDefaults = getStageConfig('focus') ?? getStageConfig('stage3');
const DEFAULT_MODEL = stageDefaults?.default_model ?? 'openrouter/gpt-5-preview';
const FALLBACK_MODEL = stageDefaults?.fallback_model ?? 'openrouter/gpt-5-mini';
const EMBEDDING_MODEL_SLUG = stageDefaults?.embedding_model ?? 'openai/text-embedding-3-small';
const requestSettings = stageDefaults?.request ?? null;
const retrySettings = unpackRetrySettings(stageDefaults?.retry);
const cacheTtlMinutes = resolveCacheTtlMinutes('focus');
const systemTemplatePromise = loadPromptTemplate('focus/system');
const userTemplatePromise = loadPromptTemplate('focus/user');
const MAX_LIMIT = 10;

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function isUuid(value: unknown) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function sanitizeTicker(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 12) return null;
  if (!/^[A-Z0-9_.-]+$/i.test(trimmed)) return null;
  return trimmed.toUpperCase();
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
    'is_staff',
    'claims_admin',
    'admin_claims',
    'is_operator',
    'operator',
    'operator_access',
    'ops',
    'ops_admin',
    'is_ops',
    'staff_access'
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
  collectRoles((profile as JsonRecord | null)?.plan, bucket);
  collectRoles((profile as JsonRecord | null)?.tier, bucket);
  collectRoles((profile as JsonRecord | null)?.team, bucket);
  collectRoles((profile as JsonRecord | null)?.department, bucket);
  collectRoles((profile as JsonRecord | null)?.groups, bucket);
  collectRoles((profile as JsonRecord | null)?.labels, bucket);
  collectRoles((profile as JsonRecord | null)?.tags, bucket);

  collectRoles(user?.app_metadata, bucket);
  collectRoles(user?.user_metadata, bucket);

  collectRoles(membership?.role, bucket);
  collectRoles(membership?.roles, bucket);
  collectRoles(membership?.access_level, bucket);
  collectRoles(membership?.plan, bucket);
  collectRoles(membership?.plan_name, bucket);
  collectRoles(membership?.tier, bucket);
  collectRoles((membership as JsonRecord | null)?.labels, bucket);
  collectRoles((membership as JsonRecord | null)?.tags, bucket);

  const privileged = new Set([
    'admin',
    'administrator',
    'superadmin',
    'owner',
    'editor',
    'staff',
    'operator',
    'operations',
    'ops',
    'internal',
    'maintainer',
    'automation',
    'builder'
  ]);
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

function formatStage1Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 1 answer unavailable.';
  const label = answer.label ?? answer.classification;
  const reasons = Array.isArray(answer.reasons) ? answer.reasons : [];
  const formattedReasons = reasons
    .slice(0, 3)
    .map((reason: unknown, index: number) => `${index + 1}. ${String(reason)}`)
    .join('\n');
  return `Label: ${label ?? 'n/a'}${formattedReasons ? `\nReasons:\n${formattedReasons}` : ''}`;
}

function formatStage2Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 2 answer unavailable.';
  const verdict = (answer.verdict as JsonRecord | undefined) ?? {};
  const summary = typeof verdict.summary === 'string' ? verdict.summary : null;
  const goDeep =
    typeof verdict.go_deep === 'boolean'
      ? verdict.go_deep
      : typeof verdict.go_deep === 'string'
        ? verdict.go_deep.toLowerCase() === 'true'
        : null;
  const goDeepLine = goDeep == null ? '' : `\nGo deep: ${goDeep ? 'yes' : 'no'}`;
  return `${summary ?? 'No verdict provided.'}${goDeepLine}`.trim();
}

function formatStage3Summary(answer: JsonRecord | null) {
  if (!answer) return 'Stage 3 thesis unavailable.';
  if (typeof answer.answer_text === 'string' && answer.answer_text.trim()) {
    return answer.answer_text.trim();
  }
  if (typeof answer.thesis === 'string' && answer.thesis.trim()) {
    return answer.thesis.trim();
  }
  if (typeof answer.summary === 'string' && answer.summary.trim()) {
    return answer.summary.trim();
  }
  return 'No Stage 3 thesis available.';
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

function formatSnippets(snippets: RetrievedSnippet[]) {
  if (!snippets.length) return 'No retrieved snippets available.';
  return snippets
    .map((snippet) => `[${snippet.ref}] ${snippet.chunk}`)
    .join('\n\n');
}

async function fetchStageAnswer(
  client: ReturnType<typeof createClient>,
  runId: string,
  ticker: string,
  stage: number,
  questionGroup?: string
): Promise<JsonRecord | null> {
  let query = client
    .from('answers')
    .select('answer_json, answer_text')
    .eq('run_id', runId)
    .eq('ticker', ticker)
    .eq('stage', stage)
    .order('created_at', { ascending: false })
    .limit(1);

  if (questionGroup) {
    query = query.eq('question_group', questionGroup);
  }

  const { data } = await query.maybeSingle();
  if (!data) return null;
  const json = (data.answer_json ?? {}) as JsonRecord;
  if (data.answer_text && typeof data.answer_text === 'string') {
    json.answer_text = data.answer_text;
  }
  return json;
}

async function fetchTickerMeta(client: ReturnType<typeof createClient>, ticker: string) {
  const { data } = await client
    .from('tickers')
    .select('name, exchange, country, sector, industry')
    .eq('ticker', ticker)
    .maybeSingle();
  return data ?? {};
}

function buildRetrievalQuery(
  ticker: string,
  meta: Record<string, unknown>,
  stage1: JsonRecord | null,
  stage2: JsonRecord | null,
  stage3: JsonRecord | null
) {
  const lines: string[] = [];
  lines.push(`Ticker: ${ticker}`);
  if (meta.name) lines.push(`Name: ${String(meta.name)}`);
  if (meta.exchange) lines.push(`Exchange: ${String(meta.exchange)}`);
  if (meta.country) lines.push(`Country: ${String(meta.country)}`);
  if (meta.sector) lines.push(`Sector: ${String(meta.sector)}`);
  if (meta.industry) lines.push(`Industry: ${String(meta.industry)}`);

  if (stage1?.summary) lines.push(`Stage 1 summary: ${String(stage1.summary)}`);
  if (Array.isArray(stage1?.reasons) && stage1.reasons.length) {
    const reasons = (stage1.reasons as unknown[])
      .slice(0, 3)
      .map((reason) => String(reason));
    lines.push(`Stage 1 reasons: ${reasons.join('; ')}`);
  }

  if (stage2?.verdict && typeof (stage2.verdict as JsonRecord)?.summary === 'string') {
    lines.push(`Stage 2 verdict: ${String((stage2.verdict as JsonRecord).summary)}`);
  }

  if (Array.isArray(stage2?.next_steps) && stage2.next_steps.length) {
    const steps = (stage2.next_steps as unknown[])
      .slice(0, 3)
      .map((step) => String(step));
    lines.push(`Stage 2 next steps: ${steps.join('; ')}`);
  }

  if (stage3?.answer_text && typeof stage3.answer_text === 'string') {
    lines.push(`Stage 3 thesis: ${stage3.answer_text}`);
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
    match_limit: Math.max(1, Math.min(options.limit ?? 6, 20))
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

  return {
    snippets,
    citations: snippetsToCitations(snippets),
    tokens: Number(embeddingResponse?.usage?.total_tokens ?? 0)
  };
}

async function computeMetrics(client: ReturnType<typeof createClient>, runId: string): Promise<FocusMetrics> {
  const { data, error } = await client.rpc('run_focus_summary', { p_run_id: runId }).maybeSingle();
  if (error) throw error;
  return {
    total_requests: Number(data?.total_requests ?? 0),
    pending: Number(data?.pending ?? 0),
    completed: Number(data?.completed ?? 0),
    failed: Number(data?.failed ?? 0)
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
    console.error('Missing Supabase configuration for focus-consume');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload for focus-consume', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const runId = typeof payload?.run_id === 'string' ? payload.run_id.trim() : '';
  if (!isUuid(runId)) {
    return jsonResponse(400, { error: 'Valid run_id required' });
  }

  const limit = clampInteger(payload?.limit, 1, MAX_LIMIT, 3);

  const serviceAuth = resolveServiceAuth(req);
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let invocationMode: 'user' | 'service' = 'user';
  let accessToken: string | null = null;
  let operatorEmail: string | null = null;
  let operatorId: string | null = null;

  if (serviceAuth.authorized) {
    invocationMode = 'service';
    operatorEmail = 'automation@futurefunds.ai';
  } else {
    const authHeader = req.headers.get('Authorization') ?? '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    accessToken = tokenMatch?.[1]?.trim() ?? null;

    if (!accessToken) {
      return jsonResponse(401, { error: 'Missing bearer token' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.error('Invalid session token for focus-consume', userError);
      return jsonResponse(401, { error: 'Invalid or expired session token' });
    }

    const user = userData.user as JsonRecord;
    operatorId = typeof user?.id === 'string' ? (user.id as string) : null;
    operatorEmail = typeof user?.email === 'string' ? (user.email as string) : null;

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      supabaseAdmin.from('memberships').select('*').eq('user_id', user.id).maybeSingle()
    ]);

    if (profileResult.error) {
      console.warn('profiles query error', profileResult.error);
    }
    if (membershipResult.error) {
      console.warn('memberships query error', membershipResult.error);
    }

    const context = {
      user,
      profile: (profileResult.data ?? null) as JsonRecord | null,
      membership: (membershipResult.data ?? null) as JsonRecord | null
    };

    if (!isAdminContext(context)) {
      return jsonResponse(403, { error: 'Admin access required' });
    }

    if (!isMembershipActiveRecord(context.membership)) {
      return jsonResponse(403, { error: 'Active membership required' });
    }
  }

  const { data: runRow, error: runError } = await supabaseAdmin
    .from('runs')
    .select('id, status, stop_requested, budget_usd, notes')
    .eq('id', runId)
    .maybeSingle();

  if (runError) {
    console.error('Failed to load run for focus-consume', runError);
    return jsonResponse(500, { error: 'Failed to load run', details: runError.message });
  }

  if (!runRow) {
    return jsonResponse(404, { error: 'Run not found' });
  }

  const stageConfigRaw = (runRow?.notes && typeof runRow.notes === 'string'
    ? (() => {
        try {
          return JSON.parse(runRow.notes) as JsonRecord;
        } catch (_error) {
          return {};
        }
      })()
    : {}) as JsonRecord;

  const plannerConfig = (stageConfigRaw?.planner ?? {}) as JsonRecord;
  const focusPlanner = (plannerConfig?.focus ?? {}) as JsonRecord;

  const modelSlug = typeof focusPlanner?.model === 'string' ? focusPlanner.model : DEFAULT_MODEL;
  const fallbackSlug = typeof focusPlanner?.fallback === 'string' ? focusPlanner.fallback : FALLBACK_MODEL;
  const credentialId = typeof focusPlanner?.credentialId === 'string' ? focusPlanner.credentialId : null;

  const modelRecord = await resolveModel(supabaseAdmin, modelSlug, fallbackSlug);
  if (!modelRecord) {
    return jsonResponse(500, { error: 'Model configuration unavailable for focus-consume' });
  }

  const credentialRecord = await resolveCredential(supabaseAdmin, {
    credentialId,
    provider: modelRecord.provider,
    preferScopes: ['automation', 'editor'],
    allowEnvFallback: true,
    envKeys: ['OPENAI_API_KEY']
  });

  if (!credentialRecord) {
    return jsonResponse(500, { error: 'Credential unavailable for focus-consume' });
  }

  let embeddingModelRecord: Awaited<ReturnType<typeof resolveModel>> | null = null;
  let embeddingCredentialRecord: Awaited<ReturnType<typeof resolveCredential>> | null = null;

  try {
    embeddingModelRecord = await resolveModel(
      supabaseAdmin,
      EMBEDDING_MODEL_SLUG,
      EMBEDDING_MODEL_SLUG
    );
  } catch (error) {
    console.warn('Focus retrieval embedding model unavailable', error);
  }

  if (embeddingModelRecord) {
    try {
      embeddingCredentialRecord = await resolveCredential(supabaseAdmin, {
        credentialId: null,
        provider: embeddingModelRecord.provider,
        preferScopes: ['automation', 'rag'],
        allowEnvFallback: true,
        envKeys: ['OPENAI_API_KEY']
      });
    } catch (error) {
      console.warn('Focus retrieval embedding credential unavailable', error);
      embeddingCredentialRecord = null;
    }
  }

  const { data: pendingRequests, error: pendingError } = await supabaseAdmin
    .from('focus_question_requests')
    .select(
      'id, ticker, question, status, template:focus_question_templates(id, slug, label), created_at, metadata'
    )
    .eq('run_id', runId)
    .in('status', ['pending', 'queued'])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (pendingError) {
    console.error('Failed to load focus requests', pendingError);
    return jsonResponse(500, { error: 'Failed to load focus requests', details: pendingError.message });
  }

  const requests = pendingRequests ?? [];

  if (!requests.length) {
    const metrics = await computeMetrics(supabaseAdmin, runId);
    return jsonResponse(200, {
      run_id: runId,
      processed: 0,
      failed: 0,
      metrics,
      results: [],
      message: metrics.pending === 0 ? 'No focus questions pending.' : 'Focus questions already in progress.'
    });
  }

  const results: FocusResult[] = [];
  let processed = 0;
  let failures = 0;
  let totalCost = 0;
  let cacheHits = 0;

  const systemPrompt = await systemTemplatePromise;
  const userTemplate = await userTemplatePromise;

  for (const request of requests) {
    const ticker = request.ticker;
    const startedAt = new Date().toISOString();

    try {
      await supabaseAdmin
        .from('focus_question_requests')
        .update({ status: 'in_progress' })
        .eq('id', request.id);

      const [meta, stage1, stage2, stage3] = await Promise.all([
        fetchTickerMeta(supabaseAdmin, ticker),
        fetchStageAnswer(supabaseAdmin, runId, ticker, 1),
        fetchStageAnswer(supabaseAdmin, runId, ticker, 2),
        fetchStageAnswer(supabaseAdmin, runId, ticker, 3, 'summary')
      ]);

      const retrievalQuery = buildRetrievalQuery(ticker, meta, stage1, stage2, stage3);
      const retrieval = await fetchRetrievedSnippets(supabaseAdmin, ticker, retrievalQuery, {
        model: embeddingModelRecord,
        credential: embeddingCredentialRecord
      });

      const renderedUser = renderTemplate(userTemplate, {
        ticker,
        question: request.question,
        stage1_summary: formatStage1Summary(stage1),
        stage2_summary: formatStage2Summary(stage2),
        stage3_summary: formatStage3Summary(stage3),
        retrieval_snippets: formatSnippets(retrieval.snippets)
      });

      const requestBody = applyRequestSettings(
        {
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: renderedUser }
          ]
        },
        requestSettings
      );

      const promptHash = await hashRequestBody(requestBody);
      const scope = request.template?.slug ? `focus-${request.template.slug}` : 'focus-custom';
      const cacheKey = buildCacheKey(['focus', ticker, scope, promptHash]);

      let cacheHit = false;
      let completion: Record<string, unknown> | null = null;
      let usage: Record<string, unknown> | null = null;

      try {
        const cached = await fetchCachedCompletion(supabaseAdmin, modelRecord.slug, cacheKey);
        if (cached) {
          cacheHit = true;
          completion = cached.response_body ?? null;
          usage = cached.usage ?? null;
          await markCachedCompletionHit(supabaseAdmin, cached.id);
        }
      } catch (error) {
        console.warn('Focus cache lookup failed', error);
      }

      if (!completion) {
        completion = await withRetry(
          retrySettings.attempts,
          retrySettings.backoffMs,
          () => requestChatCompletion(modelRecord, credentialRecord, requestBody),
          { jitter: retrySettings.jitter }
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
            {
              ttlMinutes: cacheTtlMinutes,
              context: {
                run_id: runId,
                ticker,
                question: request.question,
                scope,
                retrieval: retrieval.citations
              }
            }
          );
        } catch (error) {
          console.warn('Focus cache write failed', error);
        }
      }

      const content = (completion as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Completion missing content');
      }

      let parsed: JsonRecord;
      try {
        parsed = JSON.parse(content) as JsonRecord;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(`Failed to parse focus response JSON: ${err}`), {
          logPayload: { raw_response: content }
        });
      }

      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : null;
      const answerText = summary ?? content.slice(0, 600);
      const promptTokens = Number(usage?.prompt_tokens ?? usage?.tokens_in ?? 0);
      const completionTokens = Number(usage?.completion_tokens ?? usage?.tokens_out ?? 0);
      const cost = computeUsageCost(modelRecord, promptTokens, completionTokens);
      totalCost += cost;
      if (cacheHit) cacheHits += 1;

      const now = new Date().toISOString();

      await supabaseAdmin
        .from('focus_question_requests')
        .update({
          status: 'answered',
          answer: { ...parsed, retrieval_citations: retrieval.citations },
          answer_text: answerText,
          tokens_in: promptTokens,
          tokens_out: completionTokens,
          cost_usd: cost,
          cache_hit: cacheHit,
          answered_at: now,
          answered_by: operatorId,
          answered_by_email: operatorEmail,
          metadata: {
            ...(request.metadata ?? {}),
            retrieval,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens
          }
        })
        .eq('id', request.id);

      await supabaseAdmin.from('answers').insert({
        run_id: runId,
        ticker,
        stage: 4,
        question_group: request.template?.slug ? `focus:${request.template.slug}` : `focus:${request.id}`,
        answer_json: { ...parsed, question: request.question, retrieval: retrieval.citations },
        answer_text: answerText,
        tokens_in: promptTokens,
        tokens_out: completionTokens,
        cost_usd: cost,
        created_at: startedAt
      });

      if (!cacheHit && cost > 0) {
        await supabaseAdmin.from('cost_ledger').insert({
          run_id: runId,
          stage: 4,
          model: modelRecord.slug,
          tokens_in: promptTokens,
          tokens_out: completionTokens,
          cost_usd: cost,
          created_at: startedAt
        });
      }

      results.push({
        id: request.id,
        ticker,
        question: request.question,
        status: 'answered',
        answer_text: answerText,
        cache_hit: cacheHit,
        citations: retrieval.citations,
        updated_at: now
      });
      processed += 1;
    } catch (error) {
      console.error(`Focus question processing failed for ${request.ticker}`, error);
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);

      const basePayload: JsonRecord =
        error && typeof (error as { logPayload?: JsonRecord }).logPayload === 'object'
          ? { ...(error as { logPayload?: JsonRecord }).logPayload }
          : {};
      basePayload.request_id = request.id;
      basePayload.ticker = request.ticker;
      basePayload.question = request.question;

      if (!(error as { logged?: boolean }).logged) {
        await recordErrorLog(supabaseAdmin, {
          context: 'focus-consume',
          message,
          runId,
          ticker: request.ticker,
          stage: 4,
          promptId: request.template?.slug ?? 'focus-custom',
          payload: basePayload
        });
        (error as { logged?: boolean }).logged = true;
      }

      await supabaseAdmin
        .from('focus_question_requests')
        .update({ status: 'failed', metadata: { ...(request.metadata ?? {}), error: message } })
        .eq('id', request.id);

      results.push({
        id: request.id,
        ticker: request.ticker,
        question: request.question,
        status: 'failed',
        answer_text: message,
        cache_hit: false,
        citations: [],
        updated_at: new Date().toISOString()
      });
    }
  }

  const metrics = await computeMetrics(supabaseAdmin, runId);

  const cacheNote = cacheHits > 0 ? ` (cache hits: ${cacheHits})` : '';
  const message =
    processed === 0
      ? failures
        ? 'All focus questions failed. See error log for details.'
        : 'No focus questions processed.'
      : `Processed ${processed} focus question${processed === 1 ? '' : 's'}${cacheNote}. Pending requests: ${metrics.pending}.`;

  return jsonResponse(200, {
    run_id: runId,
    processed,
    failed: failures,
    metrics,
    results,
    cost: { total_usd: totalCost, cache_hits: cacheHits },
    message,
    timestamp: new Date().toISOString()
  });
});
