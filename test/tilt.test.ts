import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tiltAt } from '../client/lib/tilt.ts';

test('tiltAt: flat in the middle, the corner under the pointer tips back, capped past the edge', () => {
  assert.deepEqual(tiltAt(0.5, 0.5), { rx: 0, ry: 0 });
  const tl = tiltAt(0, 0);
  assert.ok(tl.rx < 0 && tl.ry > 0);
  assert.deepEqual(tiltAt(-3, 9), tiltAt(0, 1));
  assert.ok(Math.abs(tiltAt(1, 1).rx) <= 7 && Math.abs(tiltAt(1, 1).ry) <= 7);
});
