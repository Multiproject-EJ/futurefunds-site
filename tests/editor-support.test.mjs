import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSupabaseError, composePromptSummary } from '../assets/editor-support.js';

test('describeSupabaseError handles string inputs', () => {
  assert.equal(describeSupabaseError('boom'), 'boom');
});

test('describeSupabaseError reduces Supabase error objects', () => {
  const error = { message: 'Permission denied', details: 'role mismatch', hint: '' };
  assert.equal(describeSupabaseError(error), 'Permission denied — role mismatch');
});

test('composePromptSummary falls back when no prompts exist', () => {
  const summary = composePromptSummary({ promptOptions: [] });
  assert.equal(summary, 'No prompts found. Add templates in Supabase.');
});

test('composePromptSummary includes description when prompt selected', () => {
  const summary = composePromptSummary({
    promptOptions: [{ description: 'anything' }],
    selectedPrompt: { description: 'Deep dive template' },
  });
  assert.equal(summary, 'Deep dive template');
});

test('composePromptSummary adds fallback warning when defaults are used', () => {
  const summary = composePromptSummary({
    promptOptions: [{ description: '' }],
    selectedPrompt: { description: '' },
    fallbackUsed: true,
  });
  assert.match(summary, /Using built-in prompts/);
});

test('composePromptSummary appends Supabase error details', () => {
  const summary = composePromptSummary({
    promptOptions: [{ description: 'ready' }],
    selectedPrompt: { description: '' },
    errorMessage: '401 Unauthorized',
  });
  assert.match(summary, /401 Unauthorized/);
});
