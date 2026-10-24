import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightProgress } from '../client/lib/zoom.ts';

test('flightProgress: 0 at the card, 1 at the backdrop, clamped, and done when there is nowhere to grow', () => {
  assert.equal(flightProgress(150, 150, 1440), 0);
  assert.equal(flightProgress(1440, 150, 1440), 1);
  assert.equal(flightProgress(795, 150, 1440), 0.5);
  assert.equal(flightProgress(2000, 150, 1440), 1);
  assert.equal(flightProgress(100, 150, 1440), 0);
  assert.equal(flightProgress(300, 300, 300), 1);
});
