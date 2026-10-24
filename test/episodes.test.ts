import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonsOf, sortedEpisodes, isReleased, nextUp, caughtUp, episodeSource } from '../client/lib/episodes.js';
import type { Episode, Progress, Source } from '../server/types.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const ep = (s: number, e: number, released?: string): Episode => ({ id: `tt1:${s}:${e}`, season: s, episode: e, title: `E${e}`, released });
const prog = (e: Episode, pos: number, updatedAt: number, dur = 100): Progress => ({ videoId: e.id, metaId: 'tt1', type: 'series', pos, dur, updatedAt, name: 'Show' });
const aired = (s: number, e: number) => ep(s, e, iso(NOW - 30 * DAY + e * DAY));
const future = (s: number, e: number) => ep(s, e, iso(NOW + e * DAY));

test('isReleased: past, future, today, missing date', () => {
  assert.equal(isReleased(ep(1, 1, iso(NOW - DAY)), NOW), true);
  assert.equal(isReleased(ep(1, 1, iso(NOW + DAY)), NOW), false);
  assert.equal(isReleased(ep(1, 1, iso(NOW)), NOW), true);
  assert.equal(isReleased(ep(1, 1), NOW), true);
});

test('nextUp and caughtUp: done means past 95 percent, the same rule as isFinished and the server', () => {
  const s1 = [aired(1, 1), aired(1, 2)];
  // Exactly 95 percent is not finished yet: stay on it, not caught up.
  assert.equal(nextUp(s1, { [s1[0].id]: prog(s1[0], 95, 1) }, NOW)?.id, 'tt1:1:1');
  assert.equal(caughtUp(s1, { [s1[1].id]: prog(s1[1], 95, 1) }, NOW), null);
  // Past it moves on.
  assert.equal(nextUp(s1, { [s1[0].id]: prog(s1[0], 95.01, 1) }, NOW)?.id, 'tt1:1:2');
  assert.ok(caughtUp(s1, { [s1[1].id]: prog(s1[1], 95.01, 1) }, NOW));
  // No duration is never done.
  assert.equal(nextUp(s1, { [s1[0].id]: prog(s1[0], 10, 1, 0) }, NOW)?.id, 'tt1:1:1');
});

test('seasonsOf puts specials last, sortedEpisodes orders by season then episode', () => {
  const vids = [ep(2, 1), ep(0, 1), ep(1, 2), ep(1, 1)];
  assert.deepEqual(seasonsOf(vids), [1, 2, 0]);
  assert.deepEqual(sortedEpisodes(vids).map((e) => e.id), ['tt1:0:1', 'tt1:1:1', 'tt1:1:2', 'tt1:2:1']);
});

test('nextUp: caught up on a show still airing lands on the last aired episode, not the future one', () => {
  const s3 = [aired(3, 1), aired(3, 2), aired(3, 3), future(3, 4), future(3, 5)];
  const progress = { [s3[2].id]: prog(s3[2], 99, 3), [s3[1].id]: prog(s3[1], 99, 2) };
  assert.equal(nextUp(s3, progress, NOW)?.id, 'tt1:3:3');
});

test('nextUp: the episode after the last finished one once it has aired', () => {
  const s3 = [aired(3, 1), aired(3, 2), aired(3, 3), future(3, 4)];
  assert.equal(nextUp(s3, { [s3[1].id]: prog(s3[1], 99, 5) }, NOW)?.id, 'tt1:3:3');
  // Half watched stays on that episode.
  assert.equal(nextUp(s3, { [s3[2].id]: prog(s3[2], 40, 5) }, NOW)?.id, 'tt1:3:3');
});

test('nextUp: never watched starts at the first aired episode, or the premiere when nothing has aired', () => {
  assert.equal(nextUp([aired(1, 1), aired(1, 2), future(1, 3)], {}, NOW)?.id, 'tt1:1:1');
  assert.equal(nextUp([future(1, 1), future(1, 2)], {}, NOW)?.id, 'tt1:1:1');
});

test('nextUp: specials never drive the pick', () => {
  const vids = [ep(0, 1, iso(NOW - 90 * DAY)), aired(1, 1), aired(1, 2)];
  assert.equal(nextUp(vids, {}, NOW)?.id, 'tt1:1:1');
  // Finishing a special most recently does not move you off the regular episode you were on.
  const progress = { [vids[1].id]: prog(vids[1], 99, 1), [vids[0].id]: prog(vids[0], 99, 9) };
  assert.equal(nextUp(vids, progress, NOW)?.id, 'tt1:1:2');
});

test('nextUp: an episode without a release date counts as aired', () => {
  const vids = [aired(1, 1), ep(1, 2)];
  assert.equal(nextUp(vids, { [vids[0].id]: prog(vids[0], 99, 1) }, NOW)?.id, 'tt1:1:2');
});

test('nextUp: a specials-only show picks the first aired special, then carries on through them', () => {
  const sp = [ep(0, 1, iso(NOW - 60 * DAY)), ep(0, 2, iso(NOW - 30 * DAY)), ep(0, 3, iso(NOW + DAY))];
  assert.equal(nextUp(sp, {}, NOW)?.id, 'tt1:0:1');
  assert.equal(nextUp(sp, { [sp[0].id]: prog(sp[0], 99, 1) }, NOW)?.id, 'tt1:0:2');
  assert.equal(nextUp([ep(0, 1, iso(NOW + DAY)), ep(0, 2, iso(NOW - DAY))], {}, NOW)?.id, 'tt1:0:2');
});

test('caughtUp: finished the last aired episode of a show still airing gives the next one to air', () => {
  const s3 = [aired(3, 1), aired(3, 2), aired(3, 3), future(3, 4), future(3, 5)];
  const progress = { [s3[2].id]: prog(s3[2], 99, 3), [s3[1].id]: prog(s3[1], 99, 2) };
  assert.equal(caughtUp(s3, progress, NOW)?.upcoming?.id, 'tt1:3:4');
});

test('caughtUp: finished the last listed episode, nothing scheduled', () => {
  const s1 = [aired(1, 1), aired(1, 2)];
  const r = caughtUp(s1, { [s1[1].id]: prog(s1[1], 99, 2) }, NOW);
  assert.ok(r);
  assert.equal(r.upcoming, undefined);
});

test('caughtUp: null when there is something to watch', () => {
  const s3 = [aired(3, 1), aired(3, 2), aired(3, 3), future(3, 4)];
  assert.equal(caughtUp(s3, {}, NOW), null);                                        // never watched
  assert.equal(caughtUp(s3, { [s3[1].id]: prog(s3[1], 99, 5) }, NOW), null);        // next one has aired
  assert.equal(caughtUp(s3, { [s3[2].id]: prog(s3[2], 40, 5) }, NOW), null);        // half watched
  // Rewatching: the pick is one you finished long ago, but aired episodes still follow it.
  const progress = { [s3[0].id]: prog(s3[0], 99, 9), [s3[1].id]: prog(s3[1], 99, 1), [s3[2].id]: prog(s3[2], 99, 2) };
  assert.equal(nextUp(s3, progress, NOW)?.id, 'tt1:3:2');
  assert.equal(caughtUp(s3, progress, NOW), null);
  assert.equal(caughtUp([], {}, NOW), null);
});

test('episodeSource: the binge group first, then the one Kino picked, then the first', () => {
  const src = (id: string, bingeGroup?: string) => ({ id, infoHash: id, addon: 'a', releaseName: id, bingeGroup }) as Source;
  const list = [src('a'), src('b', 'grp'), src('c')];
  assert.equal(episodeSource(list, 'c', 'grp')?.id, 'b');
  assert.equal(episodeSource(list, 'c', 'other')?.id, 'c');
  assert.equal(episodeSource(list, undefined, null)?.id, 'a');
  assert.equal(episodeSource([], 'c'), undefined);
});
