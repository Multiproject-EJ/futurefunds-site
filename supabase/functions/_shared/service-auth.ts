import { timingSafeEqual } from 'https://deno.land/std@0.210.0/crypto/timing_safe_equal.ts';

export type ServiceAuthResult = {
  authorized: boolean;
  providedSecret: string | null;
  reason?: string;
};

const HEADER_KEY = 'x-automation-secret';
const QUERY_KEY = 'automation_secret';

function constantTimeMatch(expected: string, provided: string) {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const providedBytes = encoder.encode(provided);
  if (expectedBytes.length !== providedBytes.length) return false;
  try {
    return timingSafeEqual(expectedBytes, providedBytes);
  } catch (error) {
    console.warn('timingSafeEqual failed', error);
    return false;
  }
}

export function resolveServiceAuth(req: Request): ServiceAuthResult {
  const secret = (Deno.env.get('AUTOMATION_SERVICE_SECRET') ?? '').trim();
  if (!secret) {
    return { authorized: false, providedSecret: null, reason: 'Service secret not configured' };
  }

  const headerSecret = (req.headers.get(HEADER_KEY) ?? '').trim();
  const url = new URL(req.url);
  const querySecret = (url.searchParams.get(QUERY_KEY) ?? '').trim();

  const provided = headerSecret || querySecret;
  if (!provided) {
    return { authorized: false, providedSecret: null, reason: 'Missing automation secret' };
  }

  const authorized = constantTimeMatch(secret, provided);
  return { authorized, providedSecret: authorized ? provided : null, reason: authorized ? undefined : 'Invalid automation secret' };
}
