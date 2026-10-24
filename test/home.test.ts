import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS } from '../server/config.ts';
import { rollOn, withRolled, watchingIds, showIds, newEpisodes, ROW_MAX, NEW_EPISODE_DAYS, WATCHING_DAYS, FOLLOWING_MAX, WATCHING_MAX } from '../server/home.ts';
import type { Episode, Meta, MetaPreview, Progress } from '../server/types.ts';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
const ep = (season: number, episode: number, released?: string, extra: Partial<Episode> = {}): Episode => ({ id: `tt1:${season}:${episode}`, season, episode, title: `E${episode}`, released, ...extra });
const prog = (videoId: string, o: Partial<Progress> = {}): Progress => ({ videoId, metaId: videoId.split(':')[0], type: 'series', pos: 100, dur: 1000, updatedAt: NOW, name: videoId, ...o });
const byId = (...ps: Progress[]): Record<string, Progress> => Object.fromEntries(ps.map((p) => [p.videoId, p]));
const show = (id: string): MetaPreview => ({ id, type: 'series', name: id });

test('rollOn: a finished episode rolls on to the next aired one, with no source and the head time', () => {
  const m: Meta = { id: 'tt1', type: 'series', name: 'Harbor', poster: 'p.jpg', background: 'b.jpg', videos: [ep(0, 1, ago(400)), ep(1, 1, ago(30)), ep(1, 2, ago(23), { thumbnail: 't.jpg' }), ep(1, 3, ago(16), { title: '' })] };
  const head = prog('tt1:1:1', { pos: 990, updatedAt: NOW - 5000, poster: 'old.jpg' });
  assert.deepEqual(rollOn(head, m, {}, NOW), { videoId: 'tt1:1:2', metaId: 'tt1', type: 'series', pos: 0, dur: 0, updatedAt: NOW - 5000, name: 'Harbor S1 E2 E2', poster: 'p.jpg', background: 't.jpg', season: 1, episode: 2 });
  assert.equal(rollOn(prog('tt1:1:2'), m, {}, NOW)?.name, 'Harbor S1 E3', 'no title, no trailing space');
  assert.equal(rollOn(prog('tt1:1:2'), m, {}, NOW)?.background, 'b.jpg', 'no still: the show background');
  assert.equal(rollOn(prog('tt1:1:2'), { ...m, poster: undefined, background: undefined }, {}, NOW)?.poster, undefined);
  assert.equal(rollOn(prog('tt1:1:3'), m, {}, NOW), undefined, 'last episode');
  assert.equal(rollOn(prog('tt1:1:1'), m, byId(prog('tt1:1:2', { pos: 990 })), NOW), undefined, 'next one already watched');
  assert.equal(rollOn(prog('tt1:1:1'), m, byId(prog('tt1:1:2', { pos: 1, dur: 1 })), NOW), undefined, 'next one marked watched');
  assert.equal(rollOn(prog('tt1:1:1'), m, byId(prog('tt1:1:2', { pos: 300 })), NOW)?.videoId, 'tt1:1:2', 'half watched still rolls on');
  const unaired: Meta = { ...m, videos: [ep(1, 1, ago(7)), ep(1, 2, ago(-7))] };
  assert.equal(rollOn(prog('tt1:1:1'), unaired, {}, NOW), undefined, 'next one has not aired');
});

test('withRolled: rolled entries mixed in by time, most recent first, at most a row', () => {
  const a = prog('tt1:1:1', { updatedAt: 3 }); const b = prog('tt2', { type: 'movie', updatedAt: 1 }); const c = prog('tt3:2:1', { updatedAt: 2 });
  assert.deepEqual(withRolled([a, b], [undefined, c]).map((p) => p.videoId), ['tt1:1:1', 'tt3:2:1', 'tt2']);
  assert.deepEqual(withRolled([], []), []);
  const many = Array.from({ length: ROW_MAX + 5 }, (_, i) => prog(`tt${i}`, { updatedAt: i }));
  const out = withRolled(many.slice(0, 10), many.slice(10));
  assert.equal(out.length, ROW_MAX);
  assert.equal(out[0].updatedAt, ROW_MAX + 4);
});

test('watchingIds: series watched lately that you do not follow, newest first, once each', () => {
  const day = (d: number) => NOW - d * DAY_MS;
  const progress = byId(
    prog('tt1:1:1', { updatedAt: day(10) }), prog('tt1:1:2', { updatedAt: day(2) }),
    prog('tt2:1:1', { updatedAt: day(5) }),
    prog('tt3:1:1', { updatedAt: day(WATCHING_DAYS) }),             // exactly at the edge: out
    prog('tt4:1:1', { updatedAt: day(WATCHING_DAYS - 1) }),
    prog('tt5', { type: 'movie', updatedAt: day(1) }),
    prog('magnet:abc:0', { metaId: 'magnet:abc', updatedAt: day(1) }),
    prog('tt6:1:1', { updatedAt: day(3) }),
  );
  assert.deepEqual(watchingIds(progress, [{ id: 'tt6' }], NOW), ['tt1', 'tt2', 'tt4']);
  assert.deepEqual(watchingIds({}, [], NOW), []);
});

test('showIds: followed shows first, then watched ones, each capped', () => {
  const following = Array.from({ length: FOLLOWING_MAX + 3 }, (_, i) => ({ id: `f${i}` }));
  const watching = Array.from({ length: WATCHING_MAX + 3 }, (_, i) => `w${i}`);
  const ids = showIds(following, watching);
  assert.equal(ids.length, FOLLOWING_MAX + WATCHING_MAX);
  assert.deepEqual([ids[0], ids[FOLLOWING_MAX - 1], ids[FOLLOWING_MAX], ids.at(-1)], ['f0', `f${FOLLOWING_MAX - 1}`, 'w0', `w${WATCHING_MAX - 1}`]);
  assert.deepEqual(showIds([{ id: 'a' }], []), ['a']);
});

test('newEpisodes: aired in the window, not finished, newest first, at most a row', () => {
  const videos = [
    ep(1, 1, ago(NEW_EPISODE_DAYS + 1)),                        // too old
    ep(1, 2, ago(NEW_EPISODE_DAYS)),                            // exactly at the edge: in
    ep(1, 3, ago(3)), ep(1, 4, ago(1)),
    ep(1, 5, ago(-1)),                                          // not out yet
    ep(0, 1, ago(2)),                                           // special
    ep(1, 6),                                                   // no date
  ];
  const out = newEpisodes([{ show: show('tt1'), videos }], byId(prog('tt1:1:3', { pos: 990 }), prog('tt1:1:4', { pos: 300 })), NOW);
  assert.deepEqual(out.map((x) => x.episode.id), ['tt1:1:4', 'tt1:1:2'], 'finished one left out, half watched kept');
  assert.equal(out[0].show.id, 'tt1');
  assert.deepEqual(newEpisodes([{ show: show('tt2') }], {}, NOW), [], 'no episode list');
  const lots = Array.from({ length: ROW_MAX + 4 }, (_, i) => ep(1, i + 1, new Date(NOW - i * 3600_000).toISOString()));
  const capped = newEpisodes([{ show: show('tt1'), videos: lots.slice(0, 12) }, { show: show('tt9'), videos: lots.slice(12) }], {}, NOW);
  assert.equal(capped.length, ROW_MAX);
  assert.deepEqual([capped[0].episode.episode, capped.at(-1)!.episode.episode], [1, ROW_MAX]);
});
