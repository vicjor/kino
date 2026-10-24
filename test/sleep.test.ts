import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLEEP_CHOICES, startSleep, sleepLeft, sleepPicked, sleepBadge, sleepWords, carrySleep, keepSleep, keptSleep } from '../client/lib/sleep.ts';

// client/lib/sleep.ts: the player's sleep timer, its sheet rows and the badge on the moon button.

const MIN = 60_000;
const picked = (s: ReturnType<typeof startSleep>) => SLEEP_CHOICES.filter((c) => sleepPicked(s, c.choice)).map((c) => c.label);

test('startSleep: minutes become a time to pause at, off and end of episode stay as they are', () => {
  assert.deepEqual(startSleep(30, 1000), { min: 30, until: 1000 + 30 * MIN });
  assert.equal(startSleep(null, 1000), null);
  assert.equal(startSleep('episode', 1000), 'episode');
});

test('sleepLeft: counts down, never below zero, zero when not timed', () => {
  const s = startSleep(15, 0);
  assert.equal(sleepLeft(s, 0), 15 * MIN);
  assert.equal(sleepLeft(s, 10 * MIN), 5 * MIN);
  assert.equal(sleepLeft(s, 20 * MIN), 0);
  assert.equal(sleepLeft('episode', 0), 0);
  assert.equal(sleepLeft(null, 0), 0);
});

test('sleepPicked: exactly one row is on, the one that was picked', () => {
  assert.deepEqual(picked(null), ['Off']);
  assert.deepEqual(picked('episode'), ['End of this episode']);
  assert.deepEqual(picked(startSleep(30, 0)), ['30 minutes']);
  assert.deepEqual(picked(startSleep(60, 0)), ['1 hour']);
});

test('sleepPicked: half way through 30 minutes the 30 minute row stays on, not the 15 minute one', () => {
  const s = startSleep(30, 0);
  assert.equal(sleepBadge(s, sleepLeft(s, 15 * MIN)), '15m', 'fifteen minutes left');
  assert.deepEqual(picked(s), ['30 minutes']);
});

test('sleepBadge: minutes left rounded up, at least 1, a word for the end of the episode, nothing when off', () => {
  assert.equal(sleepBadge(startSleep(45, 0), 45 * MIN), '45m');
  assert.equal(sleepBadge(startSleep(45, 0), 44 * MIN + 1), '45m');
  assert.equal(sleepBadge(startSleep(15, 0), 0), '1m');
  assert.equal(sleepBadge('episode', 0), 'End');
  assert.equal(sleepBadge(null, 0), undefined);
});

test('sleepWords: the button label in full words', () => {
  assert.equal(sleepWords(null, 0), 'Sleep timer');
  assert.equal(sleepWords('episode', 0), 'Sleep timer: pauses at the end of this episode');
  assert.equal(sleepWords(startSleep(30, 0), 30 * MIN), 'Sleep timer: pauses in 30 minutes');
  assert.equal(sleepWords(startSleep(15, 0), 30_000), 'Sleep timer: pauses in 1 minute');
});

test('carrySleep: "End of this episode" never reaches the next episode, only another source of the same one', () => {
  const ep1 = { videoId: 'tt1:1:1', metaId: 'tt1' }, ep2 = { videoId: 'tt1:1:2', metaId: 'tt1' };
  const kept = { sleep: 'episode' as const, ...ep1 };
  assert.equal(carrySleep(kept, ep1), 'episode', 'switched source mid-episode');
  assert.equal(carrySleep(kept, ep2), null, 'the next episode plays on');
  assert.equal(carrySleep({ sleep: 'episode', videoId: '', metaId: '' }, { videoId: '', metaId: '' }), null, 'no id: nothing to match');
  assert.equal(carrySleep(null, ep1), null);
  assert.equal(carrySleep({ sleep: null, ...ep1 }, ep1), null);
});

test('carrySleep: a timed sleep keeps counting into the next episode of the same title, until it goes off', () => {
  const ep1 = { videoId: 'tt1:1:1', metaId: 'tt1' };
  const s = startSleep(30, 0);
  const kept = { sleep: s, ...ep1 };
  assert.equal(carrySleep(kept, { videoId: 'tt1:1:2', metaId: 'tt1' }, 10 * MIN), s);
  assert.equal(carrySleep(kept, { videoId: 'tt1:1:2', metaId: 'tt1' }, 31 * MIN), null, 'already gone off');
  assert.equal(carrySleep(kept, { videoId: 'tt2', metaId: 'tt2' }, 10 * MIN), null, 'another title starts without it');
});

test('keepSleep and keptSleep: the last player hands its timer to the next one', () => {
  const ep1 = { videoId: 'tt1:1:1', metaId: 'tt1' };
  keepSleep('episode', ep1);
  assert.equal(keptSleep(ep1), 'episode');
  assert.equal(keptSleep({ videoId: 'tt1:1:2', metaId: 'tt1' }), null);
  keepSleep(null, ep1);
  assert.equal(keptSleep(ep1), null, 'turned off, or gone off');
});
