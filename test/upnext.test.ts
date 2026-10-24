import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, cancel, countdownCues, countdownSec, current, decorate, resume, start, stop, tick, type Deps, type Plan } from '../server/cast/upnext.ts';
import { runShutdown } from '../server/lifecycle.ts';
import type { CastStatus, UpNext } from '../server/types.ts';

const up: UpNext = { episode: { id: 'tt1:2:4', season: 2, episode: 4, title: 'The Long Night' }, videoId: 'tt1:2:4', show: 'Harbor', confidence: 'high' };

test('countdownCues: one cue per second on the receiver clock, then a "starting" cue', () => {
  const now = 1_000_000;
  const cues = countdownCues({ ...up, startsAt: now + 3000 }, 100, now);
  assert.equal(cues.length, 4);
  assert.match(cues[0], /^00:01:40\.000 --> 00:01:41\.000 line:/);
  assert.match(cues[0], /Up next: S2 E4 The Long Night\nPlaying in 3 s$/);
  assert.match(cues[2], /Playing in 1 s$/);
  assert.match(cues[3], /^00:01:43\.000 --> 00:01:51\.000 .*\nStarting…$/s);
});
test('countdownCues: without a countdown, one nudge; nothing without an up next', () => {
  const cues = countdownCues(up, 5.5);
  assert.equal(cues.length, 1);
  assert.match(cues[0], /^00:00:05\.500 --> 00:00:25\.500 /);
  assert.deepEqual(countdownCues(undefined, 0), []);
});
test('decorate leaves an inactive status alone', () => {
  assert.deepEqual(decorate({ active: false }), { active: false });
});

const next = { id: 'tt1:1:2', season: 1, episode: 2, title: 'Two' };
const T0 = 1_700_000_000_000;

/** A fake cast session on episode 1 (50 min) with the engine wired to it, no timer, no Cinemeta. */
async function rig(planned: Partial<Plan> = {}, opts: { autoNext?: boolean; autoNextDelaySec?: number } = {}) {
  let st: CastStatus = { active: true, type: 'series', videoId: 'tt1:1:1', duration: 3000, currentTime: 0, state: 'PLAYING' };
  const n = { castNext: 0, publish: 0, show: 0, hide: 0 };
  const settings = { autoNext: opts.autoNext ?? true, autoNextDelaySec: opts.autoNextDelaySec ?? 10 };
  const d: Deps = {
    status: () => st, publish: () => { n.publish++; }, onShow: () => { n.show++; }, onHide: () => { n.hide++; },
    castNext: async () => { n.castNext++; }, settings: () => settings,
    plan: async () => ({ next, show: 'Show', creditsAt: 2800, confidence: 'high', ...planned }),
  };
  _reset(d);
  tick(T0, d); await new Promise(setImmediate);   // first tick starts the plan, then it resolves
  const at = (pos: number, now = T0, state: CastStatus['state'] = 'PLAYING') => { st = { ...st, currentTime: pos, state }; tick(now, d); return current(); };
  return { n, at, d, set: (p: Partial<CastStatus>) => { st = { ...st, ...p }; } };
}

test('tick: the popup appears at creditsAt with the countdown from the settings', async () => {
  const { n, at } = await rig();
  assert.equal(at(2799), undefined);
  const u = at(2800);
  assert.equal(u?.videoId, 'tt1:1:2');
  assert.equal(u?.confidence, 'high');
  assert.equal(u?.startsAt, T0 + 10_000);
  assert.equal(n.show, 1);
  at(2801);
  assert.equal(n.show, 1);
});

test('tick: no popup while the TV buffers at the credits, and no countdown with auto-next off', async () => {
  const { at } = await rig({}, { autoNext: false });
  assert.equal(at(2850, T0, 'BUFFERING'), undefined);
  const u = at(2850);
  assert.ok(u);
  assert.equal(u.startsAt, undefined);
});

test('tick: a rewind more than 8 s before the credits takes the popup down, it comes back', async () => {
  const { n, at } = await rig();
  at(2800);
  assert.ok(at(2793));   // 7 s back: still up
  assert.equal(at(2791), undefined);
  assert.equal(n.hide, 1);
  assert.ok(at(2800));
  assert.equal(n.show, 2);
});

test('tick: the countdown waits while PAUSED, then casts the next episode once', async () => {
  const { n, at } = await rig();
  at(2800, T0);
  for (let i = 1; i <= 5; i++) at(2801, T0 + i * 1000, 'PAUSED');
  assert.equal(at(2802, T0 + 6000)?.startsAt, T0 + 15_000);
  at(2810, T0 + 14_999);
  assert.equal(n.castNext, 0);
  at(2811, T0 + 15_000);
  at(2812, T0 + 16_000);
  at(2813, T0 + 17_000);
  assert.equal(n.castNext, 1);
});

test('tick: cancel() takes the popup down and nothing plays next', async () => {
  const { n, at } = await rig();
  assert.ok(at(2800));
  cancel();
  assert.equal(n.hide, 1);
  assert.equal(at(2801), undefined);
  assert.equal(decorate({ active: true, videoId: 'tt1:1:1' }).stopAfter, true);
  at(2900, T0 + 60_000);
  assert.equal(n.castNext, 0);
});

test('tick: cancel() before the credits means a popup without a countdown', async () => {
  const { n, at } = await rig();
  at(1000);
  cancel();
  const u = at(2800);
  assert.ok(u);
  assert.equal(u.startsAt, undefined);
  at(2999, T0 + 60_000);
  assert.equal(n.castNext, 0);
});

test('tick: confidence none falls back to 30 s before the end, countdown capped at 20 s', async () => {
  const { at } = await rig({ creditsAt: 2000, confidence: 'none' }, { autoNextDelaySec: 30 });
  assert.equal(at(2000), undefined);
  assert.equal(at(2969), undefined);
  const u = at(2970);
  assert.equal(u?.confidence, 'none');
  assert.equal(u?.startsAt, T0 + 20_000);
});

test('tick: low confidence shows the popup at creditsAt, counts down only from 30 s before the end', async () => {
  const { n, at } = await rig({ confidence: 'low' }, { autoNextDelaySec: 30 });
  const u = at(2800);
  assert.ok(u);
  assert.equal(u.startsAt, undefined);
  assert.equal(at(2969, T0 + 169_000)?.startsAt, undefined);
  assert.equal(at(2970, T0 + 170_000, 'BUFFERING')?.startsAt, undefined, 'not while the TV buffers');
  const published = n.publish;
  assert.equal(at(2970, T0 + 171_000)?.startsAt, T0 + 191_000, 'capped at 20 s like the fallback');
  assert.equal(n.publish, published + 1, 'phones learn the countdown');
  assert.equal(n.show, 1, 'the popup was up already');
  at(2989, T0 + 190_999);
  assert.equal(n.castNext, 0);
  at(2990, T0 + 191_000);
  assert.equal(n.castNext, 1);
});

test('tick: a low estimate inside the last 30 s counts down at once, capped like the fallback', async () => {
  const { at } = await rig({ confidence: 'low', creditsAt: 2980 }, { autoNextDelaySec: 30 });
  assert.equal(at(2980)?.startsAt, T0 + 20_000);
});

test('tick: undoing "stop after this episode" while the popup is up starts the countdown', async () => {
  const { at } = await rig();
  at(1000); cancel();
  assert.equal(at(2800)?.startsAt, undefined);
  resume();
  assert.equal(at(2801, T0 + 1000)?.startsAt, T0 + 11_000);
});

test('tick: a paused countdown moves on by the time that really passed between ticks', async () => {
  const { n, at } = await rig();
  at(2800, T0);                                   // ends at T0 + 10 s
  at(2801, T0 + 1000);                            // played 1 s
  at(2801, T0 + 3500, 'PAUSED');                  // a late tick: 2.5 s paused
  at(2801, T0 + 3700, 'PAUSED');                  // an early one: 0.2 s more
  assert.equal(current()?.startsAt, T0 + 12_700);
  at(2802, T0 + 4700);
  at(2810, T0 + 12_699);
  assert.equal(n.castNext, 0);
  at(2811, T0 + 12_700);
  assert.equal(n.castNext, 1);
});

test('countdownSec: high and medium count from the credits, low and none only in the last 30 s, capped at 20', () => {
  assert.equal(countdownSec('high', 2000, 3000, 10), 10);
  assert.equal(countdownSec('medium', 2000, 3000, 45), 45);
  assert.equal(countdownSec('high', 2000, 3000, 1), 3, 'never under 3 s');
  for (const c of ['low', 'none'] as const) {
    assert.equal(countdownSec(c, 2969, 3000, 10), undefined, c);
    assert.equal(countdownSec(c, 2970, 3000, 10), 10, c);
    assert.equal(countdownSec(c, 2990, 3000, 45), 20, c);
  }
});

test('tick: a failed auto-next clears the countdown instead of retrying', async () => {
  const { n, at, d } = await rig({}, { autoNextDelaySec: 3 });
  d.castNext = async () => { n.castNext++; throw new Error('device gone'); };
  at(2800, T0);
  at(2803, T0 + 3000); await new Promise(setImmediate);
  assert.equal(n.castNext, 1);
  assert.ok(at(2804, T0 + 4000));
  assert.equal(current()?.startsAt, undefined);
  at(2810, T0 + 10_000);
  assert.equal(n.castNext, 1);
});

test('tick: the cast ending clears the popup and the stop-after flag', async () => {
  const { n, at, d, set } = await rig();
  at(1000); cancel();
  assert.ok(at(2800));
  set({ active: false }); tick(T0, d);
  assert.equal(n.hide, 1);   // the overlay on the TV comes down too
  assert.equal(current(), undefined);
  set({ active: true }); tick(T0, d);
  assert.equal(decorate({ active: true, videoId: 'tt1:1:1' }).stopAfter, undefined);
});

test('start: one engine however often it starts, on the latest wiring; stop ends it and a start after runs it again', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const counted = (n: { ticks: number }): Deps => ({ status: () => { n.ticks++; return { active: false }; }, castNext: async () => undefined, publish: () => undefined });
  const a = { ticks: 0 }, b = { ticks: 0 }, c = { ticks: 0 };
  try {
    start(counted(a));
    start(counted(b));   // the manager wired up twice: still one timer, ticking the new wiring
    t.mock.timers.tick(3000);
    assert.deepEqual([a.ticks, b.ticks], [0, 3]);
    stop(); stop();
    t.mock.timers.tick(5000);
    assert.equal(b.ticks, 3, 'nothing ticks after stop');
    start(counted(c));
    t.mock.timers.tick(2000);
    assert.deepEqual([b.ticks, c.ticks], [3, 2]);
  } finally { stop(); _reset(); }
});

// Last in this file: a shutdown marks the lifecycle module as stopping for good.
test('the shutdown stops the engine start() wired', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const n = { ticks: 0 };
  start({ status: () => { n.ticks++; return { active: false }; }, castNext: async () => undefined, publish: () => undefined });
  t.mock.timers.tick(1000);
  assert.equal(n.ticks, 1);
  await runShutdown({ flush: () => undefined, now: [], cast: async () => undefined, torrent: async () => undefined, closeHttp: () => undefined });
  t.mock.timers.tick(5000);
  assert.equal(n.ticks, 1, 'no tick after the shutdown');
  _reset();
});
