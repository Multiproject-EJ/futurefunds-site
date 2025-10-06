// shared/prompt-validators.js
// Utility validators for Stage 1–3 LLM responses.

/**
 * @typedef {{ valid: boolean; errors: string[] }} ValidationResult
 */

const STAGE1_LABELS = new Set(['uninvestible', 'borderline', 'consider']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isStringArray(value, { min = 0, max = Infinity, maxLength = 400 } = {}) {
  if (!Array.isArray(value)) return false;
  if (value.length < min || value.length > max) return false;
  return value.every((entry) => {
    const text = sanitizeString(entry);
    return Boolean(text) && text.length <= maxLength;
  });
}

function ensureNumeric(value, { min = -Infinity, max = Infinity } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < min || num > max) return null;
  return num;
}

function result(errors) {
  return { valid: errors.length === 0, errors };
}

export function validateStage1Response(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return result(['Response must be an object']);
  }

  const label = sanitizeString(payload.label);
  if (!label) {
    errors.push('`label` is required');
  } else if (!STAGE1_LABELS.has(label.toLowerCase())) {
    errors.push('`label` must be one of uninvestible, borderline, consider');
  }

  if (!isStringArray(payload.reasons, { min: 1, max: 10, maxLength: 240 })) {
    errors.push('`reasons` must include at least one short string reason');
  }

  const flags = isPlainObject(payload.flags) ? payload.flags : null;
  if (!flags) {
    errors.push('`flags` object is required');
  } else {
    ['leverage', 'governance', 'dilution'].forEach((key) => {
      if (!sanitizeString(flags[key])) {
        errors.push('`flags.' + key + '` must be a descriptive string');
      }
    });
  }

  return result(errors);
}

export function validateStage2Response(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return result(['Response must be an object']);
  }

  const scores = isPlainObject(payload.scores) ? payload.scores : null;
  if (!scores) {
    errors.push('`scores` object is required');
  } else {
    const requiredBuckets = ['profitability', 'reinvestment', 'leverage', 'moat', 'timing'];
    requiredBuckets.forEach((bucket) => {
      const entry = scores[bucket];
      if (!isPlainObject(entry)) {
        errors.push('`scores.' + bucket + '` must be an object');
        return;
      }
      const score = ensureNumeric(entry.score, { min: -5, max: 5 });
      if (score === null) {
        errors.push('`scores.' + bucket + '.score` must be a number between -5 and 5');
      }
      if (!sanitizeString(entry.rationale)) {
        errors.push('`scores.' + bucket + '.rationale` must be a non-empty string');
      }
    });
  }

  const verdict = isPlainObject(payload.verdict) ? payload.verdict : null;
  if (!verdict) {
    errors.push('`verdict` object is required');
  } else if (typeof verdict.go_deep !== 'boolean') {
    errors.push('`verdict.go_deep` must be a boolean');
  }

  if (payload.next_steps && !isStringArray(payload.next_steps, { min: 0, max: 10, maxLength: 280 })) {
    errors.push('`next_steps` must be an array of concise strings when present');
  }

  return result(errors);
}

export function validateStage3QuestionResponse(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return result(['Response must be an object']);
  }

  const verdict = sanitizeString(payload.verdict || payload.rating || payload.outlook);
  if (!verdict) {
    errors.push('At least one of `verdict`, `rating`, or `outlook` must be provided');
  }

  if (payload.score !== undefined || payload.numeric_score !== undefined) {
    const score = ensureNumeric(payload.score ?? payload.numeric_score, { min: 0, max: 100 });
    if (score === null) {
      errors.push('`score` must be a number between 0 and 100 when provided');
    }
  }

  if (payload.tags && !isStringArray(payload.tags, { min: 0, max: 12, maxLength: 60 })) {
    errors.push('`tags` must be an array of short strings when present');
  }

  if (payload.signals && !isStringArray(payload.signals, { min: 0, max: 12, maxLength: 280 })) {
    errors.push('`signals` must be an array of short strings when present');
  }

  if (payload.summary && !sanitizeString(payload.summary)) {
    errors.push('`summary` must be a non-empty string when provided');
  }

  return result(errors);
}

export function validateStage3SummaryResponse(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return result(['Response must be an object']);
  }

  const thesis = sanitizeString(payload.thesis || payload.narrative || payload.summary);
  if (!thesis) {
    errors.push('Summary response must include a `thesis`, `narrative`, or `summary` string');
  }

  if (payload.scoreboard && !Array.isArray(payload.scoreboard)) {
    errors.push('`scoreboard` must be an array when provided');
  }

  return result(errors);
}

export function explainValidation(result) {
  if (!result || result.valid) return 'valid';
  return result.errors.join('; ');
}

export default {
  validateStage1Response,
  validateStage2Response,
  validateStage3QuestionResponse,
  validateStage3SummaryResponse,
  explainValidation
};
