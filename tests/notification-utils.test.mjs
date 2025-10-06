import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampScore,
  compareConvictionLevel,
  computeEnsembleScore,
  normalizeConviction,
  normalizeSummary
} from '../shared/notification-utils.js';

test('normalizeConviction recognises high conviction variants', () => {
  const veryHigh = normalizeConviction('Very High conviction');
  assert.equal(veryHigh.level, 'very_high');
  assert.equal(veryHigh.text, 'Very High conviction');

  const medium = normalizeConviction('Medium risk');
  assert.equal(medium.level, 'medium');
  assert.equal(medium.text, 'Medium risk');

  const fallback = normalizeConviction('    ');
  assert.equal(fallback.level, 'unknown');
  assert.equal(fallback.text, null);
});

test('normalizeSummary trims and filters blank text', () => {
  assert.equal(normalizeSummary('  Something interesting  '), 'Something interesting');
  assert.equal(normalizeSummary('   '), null);
  assert.equal(normalizeSummary(123), null);
});

test('computeEnsembleScore averages weighted scores safely', () => {
  const score = computeEnsembleScore([
    { score: 80, weight: 2 },
    { ensembleScore: 60, weight: 1 },
    { score: 'ignored', weight: 4 }
  ]);
  assert.equal(score, 73.33);
});

test('computeEnsembleScore returns null when entries invalid', () => {
  assert.equal(computeEnsembleScore([]), null);
  assert.equal(computeEnsembleScore([{ score: 'bad', weight: -1 }]), null);
});

test('clampScore enforces 0-100 bounds', () => {
  assert.equal(clampScore(-5), 0);
  assert.equal(clampScore(50.1234), 50.12);
  assert.equal(clampScore(500), 100);
  assert.equal(clampScore('oops'), null);
});

test('compareConvictionLevel sorts by severity', () => {
  const levels = ['unknown', 'low', 'medium', 'high', 'very_high'];
  const shuffled = ['high', 'unknown', 'very_high', 'medium', 'low'];
  shuffled.sort(compareConvictionLevel);
  assert.deepEqual(shuffled, levels);
});
