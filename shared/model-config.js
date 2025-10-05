let spec;
try {
  const module = await import('../config/models.json', { assert: { type: 'json' } });
  spec = module.default;
} catch (_error) {
  if (typeof Deno !== 'undefined' && Deno.readTextFile) {
    const text = await Deno.readTextFile(new URL('../config/models.json', import.meta.url));
    spec = JSON.parse(text);
  } else {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(new URL('../config/models.json', import.meta.url), 'utf8');
    spec = JSON.parse(text);
  }
}

if (!spec) {
  throw new Error('Model configuration (config/models.json) could not be loaded');
}

const frozenModels = Object.freeze(
  Object.fromEntries(
    Object.entries(spec.models ?? {}).map(([slug, profile]) => [slug, deepFreeze({ ...profile, slug })])
  )
);

const frozenStages = Object.freeze(
  Object.fromEntries(
    Object.entries(spec.stages ?? {}).map(([key, value]) => [key, deepFreeze({ ...value })])
  )
);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => {
      if (entry && typeof entry === 'object') {
        deepFreeze(entry);
      }
    });
    return Object.freeze(value);
  }
  return value;
}

/**
 * @typedef {object} ModelProfile
 * @property {string} [label]
 * @property {string} provider
 * @property {string} model_name
 * @property {number} [price_in]
 * @property {number} [price_out]
 * @property {Record<string, unknown>} [metadata]
 * @property {string} [slug]
 */

/**
 * @typedef {object} StageRequestSettings
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {number} [max_tokens]
 * @property {number} [max_output_tokens]
 * @property {number} [presence_penalty]
 * @property {number} [frequency_penalty]
 * @property {string[]} [stop_sequences]
 * @property {Record<string, unknown>} [metadata]
 * @property {Record<string, unknown>} [cache]
 */

/**
 * @typedef {object} StageRetrySettings
 * @property {number} [attempts]
 * @property {number} [backoff_ms]
 * @property {number} [jitter]
 */

/**
 * @typedef {object} StageDefaults
 * @property {string} [default_model]
 * @property {string} [fallback_model]
 * @property {string} [embedding_model]
 * @property {StageRequestSettings} [request]
 * @property {StageRetrySettings} [retry]
 */

/**
 * @returns {ModelProfile | null}
 */
export function getModelProfile(slug) {
  return frozenModels[slug] ?? null;
}

/**
 * @returns {Record<string, ModelProfile>}
 */
export function getAllModels() {
  return frozenModels;
}

/**
 * @returns {StageDefaults | null}
 */
export function getStageDefaults(stage) {
  return frozenStages[stage] ?? null;
}

/**
 * @returns {Record<string, StageDefaults>}
 */
export function getAllStageDefaults() {
  return frozenStages;
}
