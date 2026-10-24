import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSpeed, scrubStep, remainingLabel } from '../client/lib/scrub.ts';

test('scrubSpeed: full speed on the bar, slower the further the finger moves away, either side', () => {
  assert.deepEqual(scrubSpeed(0), { rate: 1, label: null });
  assert.deepEqual(scrubSpeed(-59), { rate: 1, label: null });
  assert.equal(scrubSpeed(80).rate, 0.5);
  assert.equal(scrubSpeed(-150).rate, 0.25);
  assert.equal(scrubSpeed(400).rate, 0.1);
  assert.equal(scrubSpeed(400).label, 'Fine scrubbing');
});

test('scrubStep: the move scaled by the speed, never off the bar', () => {
  assert.equal(scrubStep(0.5, 0.2, 1), 0.7);
  assert.equal(scrubStep(0.5, 0.2, 0.5), 0.6);
  assert.equal(scrubStep(0.9, 0.5, 1), 1);
  assert.equal(scrubStep(0.1, -0.5, 1), 0);
});

test('remainingLabel: a minus sign, what is left, never below zero', () => {
  const fmt = (s: number) => String(Math.round(s));
  assert.equal(remainingLabel(30, 100, fmt), '−70');
  assert.equal(remainingLabel(120, 100, fmt), '−0');
});
