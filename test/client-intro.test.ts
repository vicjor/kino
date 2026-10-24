import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inIntro, trackJump, learnable } from '../client/lib/intro.ts';

// client/lib/intro.ts: when the button shows, and which seeks count as skipping the titles.

test('inIntro: from the start of the titles to three seconds before they end', () => {
  const w = { start: 100, end: 190, source: 'learned' as const, confidence: 'high' as const };
  assert.equal(inIntro(w, 98), false);
  assert.equal(inIntro(w, 99), true);
  assert.equal(inIntro(w, 186), true);
  assert.equal(inIntro(w, 187), false, 'gone just before the end, so it never flickers at the edge');
  assert.equal(inIntro({ source: 'none', confidence: 'none' }, 120), false);
  assert.equal(inIntro(null, 120), false);
});

test('trackJump: three quick taps on +10 s are one thirty-second skip', () => {
  let j = trackJump(null, 100, 110, 0);
  j = trackJump(j, 110.5, 120.5, 800);
  j = trackJump(j, 121, 131, 1600);
  assert.deepEqual(j, { from: 100, to: 131, at: 1600 });
  assert.equal(learnable(j), true);
  assert.equal(trackJump(j, 131, 100, 1700), null, 'a jump back cancels');
  assert.deepEqual(trackJump(j, 131, 141, 9000), { from: 131, to: 141, at: 9000 }, 'a pause between taps starts a new one');
  assert.deepEqual(trackJump(j, 400, 410, 2000), { from: 400, to: 410, at: 2000 }, 'a jump from somewhere else starts a new one');
});

test('learnable: only early skips of a sensible length', () => {
  assert.equal(learnable({ from: 100, to: 110, at: 0 }), false, 'one tap is a nudge');
  assert.equal(learnable({ from: 100, to: 500, at: 0 }), false, 'seven minutes is skipping a scene');
  assert.equal(learnable({ from: 1000, to: 1060, at: 0 }), false, 'too late for titles');
  assert.equal(learnable(null), false);
});
