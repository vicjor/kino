import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startChord, endChord, chordPending, CHORD_MS } from '../client/lib/keys.ts';

test('chordPending: nothing pending before any "g"', () => {
  assert.equal(chordPending(undefined, 1_000_000), false);
});

test('chordPending: pending for CHORD_MS after a bare "g", then not', () => {
  startChord(1000);
  assert.equal(chordPending(undefined, 1000), true);
  assert.equal(chordPending(undefined, 1000 + CHORD_MS - 1), true);
  assert.equal(chordPending(undefined, 1000 + CHORD_MS), false);
});

test('chordPending: the key that ends a chord stays claimed for every listener, other keys do not', () => {
  const h = {}; const later = {};
  startChord(5000);
  endChord(h);
  assert.equal(chordPending(h, 5100), true, 'a listener running after the palette on the same keydown');
  assert.equal(chordPending(later, 5200), false, 'the next key is the cast keys again');
  assert.equal(chordPending(undefined, 5200), false);
});

test('chordPending: a new "g" releases the previous closing key', () => {
  const h = {};
  startChord(0); endChord(h); startChord(10_000);
  assert.equal(chordPending(h, 20_000), false);
});
