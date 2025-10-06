import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateStage1Response,
  validateStage2Response,
  validateStage3QuestionResponse,
  validateStage3SummaryResponse
} from '../shared/prompt-validators.js';
import { renderTemplate } from '../shared/template.js';
import { getModelProfile, getStageDefaults } from '../shared/model-config.js';

test('Stage 1 validator accepts canonical payload', () => {
  const result = validateStage1Response({
    label: 'consider',
    reasons: ['Resilient balance sheet', 'Recurring revenue'],
    flags: {
      leverage: 'Net cash position',
      governance: 'Aligned founder-CEO',
      dilution: 'Low historical dilution'
    }
  });
  assert.equal(result.valid, true);
});

test('Stage 1 validator rejects missing flags', () => {
  const result = validateStage1Response({
    label: 'consider',
    reasons: ['Solid unit economics']
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((line) => line.includes('flags')));
});

test('Stage 2 validator enforces go-deep boolean and scores', () => {
  const result = validateStage2Response({
    scores: {
      profitability: { score: 3, rationale: 'Expanding margins' },
      reinvestment: { score: 2, rationale: 'High ROI projects' },
      leverage: { score: 0, rationale: 'Net cash' },
      moat: { score: 4, rationale: 'Switching costs' },
      timing: { score: 1, rationale: 'Favourable catalysts' }
    },
    verdict: { go_deep: true },
    next_steps: ['Monitor Q3 guidance']
  });
  assert.equal(result.valid, true);
});

test('Stage 2 validator rejects malformed score buckets', () => {
  const result = validateStage2Response({
    scores: {
      profitability: { score: 'high', rationale: '' }
    },
    verdict: { go_deep: 'yes' }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((line) => line.includes('scores.profitability')));
});

test('Stage 3 question validator supports verdicts and optional extras', () => {
  const result = validateStage3QuestionResponse({
    verdict: 'good',
    score: 82,
    summary: 'Strong reinvestment runway backed by high ROIC.',
    tags: ['capital-allocation']
  });
  assert.equal(result.valid, true);
});

test('Stage 3 summary validator requires thesis text', () => {
  const valid = validateStage3SummaryResponse({
    thesis: 'Compounder with durable moats.',
    scoreboard: []
  });
  assert.equal(valid.valid, true);

  const invalid = validateStage3SummaryResponse({});
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((line) => line.includes('thesis')));
});

test('Template renderer interpolates tokens and omits missing values', () => {
  const output = renderTemplate('Ticker {{ticker}} / Sector {{sector}} / Missing {{unknown}}', {
    ticker: 'AAPL',
    sector: 'Technology'
  });
  assert.equal(output, 'Ticker AAPL / Sector Technology / Missing ');
});

test('Model config exposes static defaults for stage automation', () => {
  const stage2 = getStageDefaults('stage2');
  assert.ok(stage2);
  assert.equal(stage2.default_model, 'openrouter/gpt-5-mini');
  assert.equal(stage2.embedding_model, 'openai/text-embedding-3-small');

  const profile = getModelProfile(stage2.default_model);
  assert.ok(profile);
  assert.equal(profile.provider, 'openrouter');
  assert.equal(profile.model_name, 'gpt-5-mini');
});
