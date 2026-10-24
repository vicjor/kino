import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNudge, NUDGE_EVERY_MS, PAUSE_CAP_MS, RECEIVER_PAUSE_MS } from '../server/cast/keepawake.js';

const MIN = 60_000;

test('no nudge in the first ten minutes of a pause', () => {
  assert.equal(shouldNudge(0, 0, 9 * MIN), false);
  assert.equal(shouldNudge(0, 0, NUDGE_EVERY_MS), true);
});

test('ten minutes after the last nudge, not before', () => {
  assert.equal(shouldNudge(0, 10 * MIN, 19 * MIN), false);
  assert.equal(shouldNudge(0, 10 * MIN, 20 * MIN), true);
});

test('the last nudge lets the receiver quit an hour into the pause, never later', () => {
  const nudges: number[] = [];
  let last = 0;
  for (let t = 0; t <= 2 * PAUSE_CAP_MS; t += 2000) if (shouldNudge(0, last, t)) { nudges.push(t); last = t; }
  assert.deepEqual(nudges, [10 * MIN, 20 * MIN, 30 * MIN, 40 * MIN]);
  assert.equal(nudges.at(-1)! + RECEIVER_PAUSE_MS, PAUSE_CAP_MS);
});
