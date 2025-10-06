import type {
  ModelProfile,
  StageDefaults,
  StageRequestSettings,
  StageRetrySettings
} from '../../shared/model-config.js';
import {
  getModelProfile as getProfile,
  getStageDefaults as getDefaults
} from '../../shared/model-config.js';

function clone<T>(value: T | null | undefined): T | null {
  if (value == null) return null;
  return structuredClone(value);
}

export function getStageConfig(stage: string): StageDefaults | null {
  return clone<StageDefaults>(getDefaults(stage) ?? null);
}

export function getStaticModel(slug: string): ModelProfile | null {
  return clone<ModelProfile>(getProfile(slug) ?? null);
}

type RequestBody = Record<string, unknown> & {
  messages?: unknown;
  response_format?: unknown;
  extra_body?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  stop?: unknown;
};

export function applyRequestSettings(
  body: RequestBody,
  settings?: StageRequestSettings | null
): RequestBody {
  if (!settings) return body;
  const next: RequestBody = { ...body };
  const assignNumeric = (
    key: keyof StageRequestSettings & keyof RequestBody,
    targetKey: keyof RequestBody = key as keyof RequestBody
  ) => {
    const value = settings[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (next as Record<string, unknown>)[targetKey as string] = value;
    }
  };

  assignNumeric('temperature');
  assignNumeric('top_p');
  assignNumeric('presence_penalty');
  assignNumeric('frequency_penalty');
  assignNumeric('max_tokens');
  assignNumeric('max_output_tokens');

  if (Array.isArray(settings.stop_sequences) && settings.stop_sequences.length) {
    next.stop = settings.stop_sequences;
  }

  if (settings.metadata && typeof settings.metadata === 'object') {
    next.metadata = {
      ...(next.metadata ?? {}),
      ...(settings.metadata as Record<string, unknown>)
    };
  }

  if (settings.cache && typeof settings.cache === 'object') {
    next.extra_body = {
      ...(next.extra_body ?? {}),
      cache: settings.cache
    };
  }

  return next;
}

export function unpackRetrySettings(settings?: StageRetrySettings | null) {
  const attempts = Math.max(1, Number(settings?.attempts ?? 1));
  const backoffMs = Math.max(0, Number(settings?.backoff_ms ?? 0));
  const jitter = Math.max(0, Number(settings?.jitter ?? 0));
  return { attempts, backoffMs, jitter };
}
