/**
 * Simple token interpolation for markdown templates.
 * @param {string} template
 * @param {Record<string, unknown>} [tokens]
 */
export function renderTemplate(template, tokens = {}) {
  if (typeof template !== 'string') {
    return '';
  }
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (match, key) => {
    const value = tokens[key];
    if (value == null) return '';
    if (Array.isArray(value)) {
      return value.join('');
    }
    return String(value);
  });
}

/**
 * Trim leading/trailing blank lines and collapse Windows newlines for portability.
 * @param {string} value
 */
export function normalizeTemplate(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
}
