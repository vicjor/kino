import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBusy, watching } from '../server/health.ts';

const IDLE = { cast: false, hlsSessions: 0, streams: 0 };

test('busy: idle only when nothing at all is playing', () => {
  assert.equal(isBusy(IDLE), false);
});

test('busy: any one viewer is enough', () => {
  assert.equal(isBusy({ ...IDLE, cast: true }), true);
  assert.equal(isBusy({ ...IDLE, hlsSessions: 1 }), true);
  assert.equal(isBusy({ ...IDLE, streams: 2 }), true);
});

const NONE = { openStreams: 0, transcoderStreams: 0, held: 0, sessions: [], cast: false };

test('watching: an HLS session counts once, as a session, and a parked one not at all', () => {
  assert.deepEqual(watching({ ...NONE, openStreams: 1, transcoderStreams: 1, sessions: [{}] }), { ...IDLE, hlsSessions: 1 }, 'its ffmpeg read is not a stream too');
  const parked = watching({ ...NONE, openStreams: 1, transcoderStreams: 1, sessions: [{ parked: true }] });
  assert.deepEqual(parked, IDLE, 'parked, its read still open: idle, so deploy-safe does not wait on it');
  assert.equal(isBusy(parked), false);
});

test('watching: streams are the reads left after ffmpeg and download holds, never below 0', () => {
  assert.equal(watching({ ...NONE, openStreams: 4, transcoderStreams: 1, held: 2 }).streams, 1);
  assert.equal(watching({ ...NONE, openStreams: 1, held: 1 }).streams, 0, 'a download for later is not a viewer');
  assert.equal(watching({ ...NONE, openStreams: 1, transcoderStreams: 1, held: 1 }).streams, 0);
  assert.deepEqual(watching({ ...NONE, cast: true }), { ...IDLE, cast: true }, 'casts pass through');
});
