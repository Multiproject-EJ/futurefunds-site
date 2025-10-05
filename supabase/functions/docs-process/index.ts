import { serve } from 'https://deno.land/std@0.210.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  resolveModel,
  resolveCredential,
  requestEmbedding
} from '../_shared/ai.ts';

type PdfJsModule = typeof import('https://esm.sh/pdfjs-dist@3.11.174/legacy/build/pdf.js');

type JsonRecord = Record<string, unknown>;

type DocRow = {
  id: string;
  ticker: string | null;
  title: string;
  source_type: string | null;
  storage_path: string;
  status: string | null;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json'
};

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;
const EMBED_CHUNK_DELAY_MS = (() => {
  const raw = Number(Deno.env.get('DOC_EMBED_DELAY_MS') ?? '120');
  return Number.isFinite(raw) && raw >= 0 ? raw : 120;
})();

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
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

async function logError(client: ReturnType<typeof createClient>, context: string, message: string, payload: JsonRecord) {
  try {
    await client.from('error_logs').insert({ context, message, payload });
  } catch (error) {
    console.error('Failed to log error', error);
  }
}

let pdfjsLibPromise: Promise<PdfJsModule | null> | null = null;

async function getPdfJsModule(): Promise<PdfJsModule | null> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('https://esm.sh/pdfjs-dist@3.11.174/legacy/build/pdf.js')
      .then((mod) => {
        const candidate = (mod as { default?: PdfJsModule }).default ?? (mod as PdfJsModule);
        return candidate ?? null;
      })
      .catch((error) => {
        console.warn('pdf.js module unavailable in docs-process runtime', error);
        return null;
      });
  }
  return pdfjsLibPromise;
}

type PdfExtractionResult = { text: string; error?: 'unsupported' | 'failed' };

async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractionResult> {
  const pdfjsLib = await getPdfJsModule();
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    console.warn('pdf.js getDocument interface unavailable');
    return { text: '', error: 'unsupported' };
  }
  try {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    let text = '';
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      text += `${pageText}\n`;
    }
    return { text };
  } catch (error) {
    console.error('PDF extraction failed', error);
    return { text: '', error: 'failed' };
  }
}

function extractHtmlText(html: string) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return doc?.body?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  } catch (error) {
    console.error('HTML extraction failed', error);
    return html.replace(/<[^>]+>/g, ' ');
  }
}

function normalizeWhitespace(text: string) {
  return text.replace(/\r\n|\r/g, '\n').replace(/\s+/g, ' ').trim();
}

function chunkText(text: string) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: { text: string; tokens: number }[] = [];
  if (!words.length) return chunks;

  const size = TARGET_TOKENS;
  const overlap = OVERLAP_TOKENS;
  let start = 0;

  while (start < words.length) {
    const end = Math.min(words.length, start + size);
    const segment = words.slice(start, end).join(' ').trim();
    if (segment.length) {
      chunks.push({ text: segment, tokens: end - start });
    }
    if (end >= words.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
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
    console.error('Missing Supabase configuration for docs-process');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const docId = typeof body?.docId === 'string' ? body.docId.trim() : '';
  if (!isUuid(docId)) {
    return jsonResponse(400, { error: 'Invalid or missing docId' });
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
    console.error('Invalid session token for docs-process', userError);
    return jsonResponse(401, { error: 'Invalid or expired session token' });
  }

  const [profileResult, membershipResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userData.user.id).maybeSingle(),
    supabaseAdmin.from('memberships').select('*').eq('user_id', userData.user.id).maybeSingle()
  ]);

  const context = {
    user: userData.user as JsonRecord,
    profile: (profileResult.data ?? null) as JsonRecord | null,
    membership: (membershipResult.data ?? null) as JsonRecord | null
  };

  if (!isAdminContext(context)) {
    return jsonResponse(403, { error: 'Admin privileges required' });
  }

  const { data: docRow, error: docError } = await supabaseAdmin
    .from('docs')
    .select('id, ticker, title, source_type, storage_path, status')
    .eq('id', docId)
    .maybeSingle();

  if (docError) {
    console.error('Failed to load doc metadata', docError);
    return jsonResponse(500, { error: 'Failed to load doc metadata' });
  }

  if (!docRow) {
    return jsonResponse(404, { error: 'Document not found' });
  }

  const storagePath = docRow.storage_path;
  const { data: fileData, error: downloadError } = await supabaseAdmin.storage.from('docs').download(storagePath);
  if (downloadError || !fileData) {
    console.error('Failed to download document', downloadError);
    await supabaseAdmin
      .from('docs')
      .update({ status: 'failed', last_error: 'Unable to download source document' })
      .eq('id', docId);
    return jsonResponse(500, { error: 'Failed to download document' });
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  const lowerPath = storagePath.toLowerCase();
  let rawText = '';
  let pdfError: PdfExtractionResult['error'] | undefined;
  if (lowerPath.endsWith('.pdf')) {
    const pdfResult = await extractPdfText(bytes);
    rawText = pdfResult.text;
    pdfError = pdfResult.error;
  } else if (lowerPath.endsWith('.html') || lowerPath.endsWith('.htm')) {
    rawText = extractHtmlText(new TextDecoder().decode(bytes));
  } else {
    rawText = new TextDecoder().decode(bytes);
  }

  rawText = normalizeWhitespace(rawText);

  if ((!rawText || rawText.length < 40) && pdfError === 'unsupported') {
    const message = 'PDF extraction is not supported in this deployment';
    await supabaseAdmin
      .from('docs')
      .update({ status: 'failed', last_error: message })
      .eq('id', docId);
    await logError(supabaseAdmin, 'docs-process', 'pdf_unsupported', { docId, storagePath });
    return jsonResponse(501, { error: message });
  }

  if (!rawText || rawText.length < 40) {
    await supabaseAdmin
      .from('docs')
      .update({ status: 'failed', last_error: 'Document contained no extractable text' })
      .eq('id', docId);
    await logError(supabaseAdmin, 'docs-process', 'empty_text', { docId, storagePath });
    return jsonResponse(422, { error: 'Document contained no extractable text' });
  }

  const chunks = chunkText(rawText).slice(0, 200);
  if (!chunks.length) {
    await supabaseAdmin
      .from('docs')
      .update({ status: 'failed', last_error: 'No chunks produced' })
      .eq('id', docId);
    await logError(supabaseAdmin, 'docs-process', 'chunking_failed', { docId });
    return jsonResponse(422, { error: 'Failed to derive chunks from document' });
  }

  let embeddingModel;
  try {
    embeddingModel = await resolveModel(supabaseAdmin, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_MODEL);
  } catch (error) {
    console.error('Embedding model resolution failed', error);
    return jsonResponse(500, { error: 'Embedding model not configured' });
  }

  let credential;
  try {
    credential = await resolveCredential(supabaseAdmin, {
      credentialId: null,
      provider: embeddingModel.provider,
      preferScopes: ['automation', 'rag', 'editor'],
      allowEnvFallback: true,
      envKeys: ['OPENAI_API_KEY']
    });
  } catch (error) {
    console.error('Embedding credential resolution failed', error);
    return jsonResponse(500, { error: 'Embedding credential not configured' });
  }

  const embeddingVectors: number[][] = [];
  let embeddingTokens = 0;

  for (const chunk of chunks) {
    const response = await requestEmbedding(embeddingModel, credential, chunk.text);
    const vector = response?.data?.[0]?.embedding as number[] | undefined;
    if (!vector) {
      await logError(supabaseAdmin, 'docs-process', 'embedding_failed', { docId, reason: 'missing_vector' });
      return jsonResponse(500, { error: 'Failed to compute embeddings' });
    }
    embeddingVectors.push(vector);
    const usage = response?.usage as Record<string, unknown> | undefined;
    const totalTokens = Number(usage?.total_tokens ?? usage?.prompt_tokens ?? 0);
    if (Number.isFinite(totalTokens)) embeddingTokens += totalTokens;
    if (EMBED_CHUNK_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, EMBED_CHUNK_DELAY_MS));
    }
  }

  const chunkRows = chunks.map((chunk, index) => ({
    doc_id: docId,
    ticker: docRow.ticker,
    source: docRow.source_type || docRow.title,
    chunk: chunk.text,
    chunk_index: index,
    token_length: chunk.tokens,
    embedding: embeddingVectors[index]
  }));

  await supabaseAdmin.from('doc_chunks').delete().eq('doc_id', docId);

  const { error: insertError } = await supabaseAdmin.from('doc_chunks').insert(chunkRows);
  if (insertError) {
    console.error('Failed to insert doc chunks', insertError);
    await supabaseAdmin
      .from('docs')
      .update({ status: 'failed', last_error: 'Failed to persist doc chunks' })
      .eq('id', docId);
    return jsonResponse(500, { error: 'Failed to persist doc chunks' });
  }

  const totalTokens = chunks.reduce((acc, chunk) => acc + chunk.tokens, 0);

  const { data: updatedDoc } = await supabaseAdmin
    .from('docs')
    .update({
      status: 'processed',
      chunk_count: chunkRows.length,
      token_count: totalTokens,
      processed_at: new Date().toISOString(),
      last_error: null
    })
    .eq('id', docId)
    .select('*')
    .maybeSingle();

  return jsonResponse(200, {
    ok: true,
    doc: updatedDoc ?? docRow,
    chunk_count: chunkRows.length,
    token_count: totalTokens,
    embedding_tokens: embeddingTokens
  });
});
