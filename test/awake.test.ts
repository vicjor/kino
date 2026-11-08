import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantAwake, keepAwakeOn, AWAKE_GRACE_MS } from '../server/awake.ts';

const MIN = 60_000;

test('wantAwake: while someone watches, then for the grace period, then never again until the next watch', () => {
  const t0 = 1_000_000_000;
  assert.equal(wantAwake(true, t0, t0), true);
  assert.equal(wantAwake(false, 0, t0), false, 'nobody watched since start: the Mac may sleep');
  assert.equal(wantAwake(false, t0, t0 + 20 * MIN), true, 'paused 20 minutes ago, the TV app quit: still awake for a resume');
  assert.equal(wantAwake(false, t0, t0 + AWAKE_GRACE_MS - 1), true);
  assert.equal(wantAwake(false, t0, t0 + AWAKE_GRACE_MS), false);
  assert.equal(wantAwake(false, t0, t0 + 5 * MIN, 5 * MIN), false, 'grace is a parameter');
});

test('keepAwakeOn: macOS only, on unless turned off', () => {
  assert.equal(keepAwakeOn(undefined, 'darwin'), true);
  assert.equal(keepAwakeOn('', 'darwin'), true);
  assert.equal(keepAwakeOn('1', 'darwin'), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' off ']) assert.equal(keepAwakeOn(off, 'darwin'), false, off);
  assert.equal(keepAwakeOn(undefined, 'linux'), false);
  assert.equal(keepAwakeOn(undefined, 'win32'), false);
});
