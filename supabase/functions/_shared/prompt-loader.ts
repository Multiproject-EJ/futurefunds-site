import { normalizeTemplate, renderTemplate } from '../../shared/template.js';

const cache = new Map<string, Promise<string>>();

function resolvePath(key: string) {
  return new URL(`../../prompts/${key}.md`, import.meta.url);
}

export function loadPromptTemplate(key: string): Promise<string> {
  if (!cache.has(key)) {
    const url = resolvePath(key);
    cache.set(
      key,
      (async () => {
        const raw = await Deno.readTextFile(url);
        return normalizeTemplate(raw);
      })()
    );
  }
  return cache.get(key)!;
}

export async function renderPrompt(key: string, tokens: Record<string, unknown>) {
  const template = await loadPromptTemplate(key);
  return renderTemplate(template, tokens);
}

export { renderTemplate } from '../../shared/template.js';
