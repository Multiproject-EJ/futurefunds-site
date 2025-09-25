// /assets/editor-support.js
// Helper utilities for the editor UI that don't depend on the DOM.

/**
 * Produce a short, human-readable description of a Supabase error object.
 * Falls back to any available message/details/hint fields and avoids
 * leaking large JSON payloads into the UI.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeSupabaseError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;

  const fields = [];

  if (typeof error === 'object') {
    const err = /** @type {{ message?: string; details?: string; hint?: string; code?: string; status?: number; statusText?: string; }} */ (error);

    if (err.message) fields.push(err.message);
    if (err.details && err.details !== err.message) fields.push(err.details);
    if (err.hint) fields.push(err.hint);

    if (!fields.length) {
      if (err.status) {
        const statusText = err.statusText || err.code || 'HTTP error';
        fields.push(`${err.status} ${statusText}`.trim());
      } else if (err.code) {
        fields.push(err.code);
      }
    }
  }

  const text = fields.filter(Boolean).join(' — ').trim();
  if (!text) return 'Unknown Supabase error';
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

/**
 * Generate the user-facing summary string shown under the prompt selector.
 *
 * @param {object} params
 * @param {Array<{ description?: string }>} [params.promptOptions]
 * @param {{ description?: string } | null} [params.selectedPrompt]
 * @param {boolean} [params.fallbackUsed]
 * @param {string} [params.errorMessage]
 * @returns {string}
 */
export function composePromptSummary({
  promptOptions = [],
  selectedPrompt = null,
  fallbackUsed = false,
  errorMessage = '',
} = {}) {
  const optionsCount = Array.isArray(promptOptions) ? promptOptions.length : 0;
  const parts = [];

  if (!optionsCount) {
    parts.push('No prompts found. Add templates in Supabase.');
  } else if (selectedPrompt) {
    const description = (selectedPrompt.description || '').trim();
    parts.push(description || 'Ready to generate with this prompt.');
  } else {
    parts.push('Choose which template to run when generating analysis.');
  }

  const trimmedError = (errorMessage || '').trim();
  if (trimmedError) {
    parts.push(`Using built-in prompts because Supabase returned an error: ${trimmedError}.`);
  } else if (fallbackUsed) {
    parts.push('Using built-in prompts. Save custom templates in Supabase to replace these defaults.');
  }

  return parts.filter(Boolean).join(' ');
}
