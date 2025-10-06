import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type ErrorLogInput = {
  context: string;
  message: string;
  runId?: string | null;
  ticker?: string | null;
  stage?: number | null;
  promptId?: string | null;
  retryCount?: number | null;
  statusCode?: number | null;
  payload?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

function sanitizeJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  try {
    const json = JSON.parse(JSON.stringify(value));
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : { value: json };
  } catch (error) {
    return { note: 'Failed to serialize payload', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function recordErrorLog(
  client: SupabaseClient,
  {
    context,
    message,
    runId = null,
    ticker = null,
    stage = null,
    promptId = null,
    retryCount = null,
    statusCode = null,
    payload = null,
    metadata = null
  }: ErrorLogInput
) {
  try {
    await client.from('error_logs').insert({
      context,
      message,
      run_id: runId,
      ticker,
      stage,
      prompt_id: promptId,
      retry_count: typeof retryCount === 'number' && Number.isFinite(retryCount) ? Math.max(retryCount, 0) : null,
      status_code: typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : null,
      payload: sanitizeJson(payload),
      metadata: sanitizeJson(metadata)
    });
  } catch (error) {
    console.error('Failed to record error log', error);
  }
}

export default recordErrorLog;
