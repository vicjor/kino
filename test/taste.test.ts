import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeds, genreTaste, seriesShare, rotate, finishRows, seedReason, showName, dominantLanguage, shelfNoise, rankByImdb, weightedRating, withImdb, imdbFloor, hiddenGems, sameGenre, cleanRating } from '../server/taste.ts';
import type { Progress, DiscoverRow, MetaPreview } from '../server/types.ts';

const DAY = 86400_000;
const NOW = Date.parse('2026-09-17T12:00:00Z');
const p = (o: Partial<Progress> & { metaId: string }): Progress => ({ videoId: o.metaId, type: 'series', pos: 2400, dur: 2500, updatedAt: NOW - DAY, name: o.metaId, ...o });

test('seeds: a binge outweighs one film, and a film outweighs a show you barely started', () => {
  const s = seeds([
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((e) => p({ metaId: 'tt-neighbours', videoId: `tt-neighbours:2:${e}`, name: `The Neighbours S2 E${e} Title`, updatedAt: NOW - e * DAY })),
    p({ metaId: 'tt-drama', videoId: 'tt-drama', type: 'movie', name: 'The Drama', pos: 5900, dur: 6000 }),
    p({ metaId: 'tt-harbor', videoId: 'tt-harbor:2:3', name: 'Harbor S2 E3 Solo', pos: 300, dur: 3000 }),
    p({ metaId: 'magnet:abc', videoId: 'magnet:abc', type: 'movie', name: 'some.file.mkv' }),
  ], NOW);
  assert.deepEqual(s.map((x) => x.metaId), ['tt-neighbours', 'tt-drama', 'tt-harbor']);
  assert.equal(s[0].episodes, 8); assert.equal(s[0].name, 'The Neighbours'); assert.equal(s[0].finished, true);
  assert.equal(s[2].finished, false);
  assert.ok(s[0].weight > s[1].weight * 3);
});

test('seeds: something you have not touched in half a year barely steers anything', () => {
  const s = seeds([p({ metaId: 'old', updatedAt: NOW - 200 * DAY }), p({ metaId: 'new', updatedAt: NOW })], NOW);
  assert.equal(s[0].metaId, 'new');
  assert.ok(s[1].weight < s[0].weight / 10);
});

test('seeds: under five percent watched is not a signal, a mark-as-watched is', () => {
  const s = seeds([p({ metaId: 'peek', pos: 60, dur: 6000 }), p({ metaId: 'marked', pos: 1, dur: 1 })], NOW);
  assert.deepEqual(s.map((x) => x.metaId), ['marked']);
});

test('genreTaste ranks by weight and discounts the tags everything carries', () => {
  const t = genreTaste([
    { weight: 3, genres: ['Drama', 'Sci-Fi', 'Thriller'] },
    { weight: 2.5, genres: ['Drama', 'Comedy'] },
    { weight: 1, genres: ['Action', 'Comedy'] },
  ]);
  assert.deepEqual(t.slice(0, 3), ['Comedy', 'Sci-Fi', 'Thriller']);
  assert.ok(t.indexOf('Drama') > t.indexOf('Comedy'));
});

test('seriesShare says how much of your watching is series', () => {
  const s = seeds([p({ metaId: 'a' }), p({ metaId: 'b' }), p({ metaId: 'c', type: 'movie' })], NOW);
  assert.ok(seriesShare(s) > 0.6);
  assert.equal(seriesShare([]), 0.5);
});

test('dominantLanguage only speaks up when it is clear', () => {
  assert.equal(dominantLanguage([{ weight: 5, lang: 'en' }, { weight: 1, lang: 'da' }, { weight: 1 }]), 'en');
  assert.equal(dominantLanguage([{ weight: 3, lang: 'en' }, { weight: 2, lang: 'ko' }]), undefined);
  assert.equal(dominantLanguage([]), undefined);
});

test('rotate moves the start one step per day and wraps', () => {
  assert.deepEqual(rotate(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 5), ['c', 'a', 'b']);
  assert.deepEqual(rotate(['a'], 9), ['a']);
});

test('seedReason and showName speak plainly', () => {
  const s = seeds([...[1, 2, 3].map((e) => p({ metaId: 'x', videoId: `x:1:${e}`, name: `Ted Lasso S4 E${e} Home` }))], NOW);
  assert.equal(seedReason(s[0]), 'You watched 3 episodes');
  assert.equal(seedReason(seeds([p({ metaId: 'm', type: 'movie', name: 'Sandstorm' })], NOW)[0]), 'You watched it');
  assert.equal(seedReason(seeds([p({ metaId: 'm', type: 'movie', name: 'Sandstorm', pos: 600, dur: 6000 })], NOW)[0]), 'You started it');
  assert.equal(showName('The Neighbours S2E7 · A Quiet Circus'), 'The Neighbours');
  assert.equal(showName('Harbor S1 E5 The Keeper’s Son'), 'Harbor');
});

test('finishRows drops what you have seen, keeps a title in one rail, and drops thin rails', () => {
  const m = (id: string): MetaPreview => ({ id, type: 'movie', name: id });
  const rows: DiscoverRow[] = [
    { key: 'a', title: 'A', items: ['1', '2', '3', '4', '5', '6', 'seen', '7'].map(m) },
    { key: 'b', title: 'B', items: ['1', '2', '8', '9', '10', '11', '12', '13'].map(m) },
    { key: 'c', title: 'C', items: ['1', '2', '3', '14', '15', '16'].map(m) },
  ];
  const out = finishRows(rows, new Set(['seen']), 6, 7);
  assert.deepEqual(out.map((r) => r.key), ['a', 'b']);
  assert.deepEqual(out[0].items.map((x) => x.id), ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(out[1].items.map((x) => x.id), ['8', '9', '10', '11', '12', '13']);
});

test('shelfNoise: cartoons and docs stay off best-rated shelves unless you watch them or asked for them', () => {
  assert.ok(shelfNoise('series').includes('Animation'));
  assert.ok(shelfNoise('series').includes('Documentary'));
  assert.ok(shelfNoise('movie').includes('Family'));
  assert.ok(!shelfNoise('series', ['Comedy', 'Animation']).includes('Animation'));
  assert.ok(!shelfNoise('series', [], 'Animation').includes('Animation'));
  assert.ok(!shelfNoise('movie', [], 'documentary').includes('Documentary'));
  assert.ok(!shelfNoise('movie').includes('Kids'));
});

test('rankByImdb: widely loved beats a cult score, unknowns keep their order at the end', () => {
  const m = (id: string): MetaPreview => ({ id, type: 'series', name: id });
  const scores = new Map([['cult', { rating: 9.1, votes: 3000 }], ['hit', { rating: 8.7, votes: 400_000 }], ['meh', { rating: 6.1, votes: 200_000 }]]);
  assert.deepEqual(rankByImdb([m('x'), m('meh'), m('cult'), m('y'), m('hit')], scores).map((x) => x.id), ['hit', 'cult', 'meh', 'x', 'y']);
  assert.ok(weightedRating(9.1, 3000) < weightedRating(8.7, 400_000));
});

test('withImdb fills a missing IMDb score and never overwrites one', () => {
  const scores = new Map([['a', { rating: 8.04, votes: 5000 }], ['b', { rating: 5, votes: 5000 }]]);
  const out = withImdb([{ id: 'a', type: 'movie', name: 'A', tmdbRating: '7.9' }, { id: 'b', type: 'movie', name: 'B', imdbRating: '7.2' }], scores);
  assert.equal(out[0].imdbRating, '8.0'); assert.equal(out[1].imdbRating, '7.2');
});

test('withImdb treats an empty or zero Cinemeta score as missing', () => {
  const scores = new Map([['a', { rating: 7.66, votes: 5000 }]]);
  const out = withImdb([{ id: 'a', type: 'series', name: 'A', imdbRating: '' }, { id: 'b', type: 'movie', name: 'B', imdbRating: ' ' }, { id: 'c', type: 'movie', name: 'C', imdbRating: 'N/A', tmdbRating: '7.1' }], scores);
  assert.equal(out[0].imdbRating, '7.7');
  assert.equal('imdbRating' in out[1], false);
  assert.equal(out[2].imdbRating, undefined); assert.equal(out[2].tmdbRating, '7.1');
});

test('cleanRating keeps real scores and drops the ways of saying none', () => {
  assert.equal(cleanRating('8.1'), '8.1'); assert.equal(cleanRating(' 7 '), '7'); assert.equal(cleanRating(6.5), '6.5');
  for (const none of ['', '  ', 'N/A', '0', '0.0', undefined, null]) assert.equal(cleanRating(none), undefined);
});

test('sameGenre matches TMDB and Cinemeta names loosely', () => {
  assert.ok(sameGenre('Sci-Fi & Fantasy', 'Sci-Fi')); assert.ok(sameGenre('Science Fiction', 'Sci-Fi')); assert.ok(sameGenre('comedy', 'Comedy'));
  assert.ok(!sameGenre('Crime', 'Comedy'));
});

test('hiddenGems: only the IMDb band per kind, best first, nudged by taste and co-watching', () => {
  const s = (id: string, type: 'movie' | 'series', genres: string[]): MetaPreview => ({ id, type, name: id, genres });
  const scores = new Map([
    ['pitt', { rating: 8.9, votes: 170_000 }],        // loved, but everyone saw it
    ['tiny', { rating: 9.4, votes: 1200 }],           // too few votes to trust
    ['meh', { rating: 7.6, votes: 20_000 }],          // hidden, not a gem (series floor is 8)
    ['thick', { rating: 8.7, votes: 30_000 }],
    ['detect', { rating: 8.6, votes: 27_000 }],
    ['pride', { rating: 7.8, votes: 66_000 }],        // a film at 7.8 is a gem, a series is not
    ['standup', { rating: 8.6, votes: 60_000 }],
    ['kids', { rating: 8.8, votes: 20_000 }],
    ['peer', { rating: 8.6, votes: 27_000 }],
  ]);
  const items = [s('pitt', 'series', ['Drama']), s('tiny', 'series', ['Comedy']), s('meh', 'series', ['Comedy']), s('detect', 'series', ['Comedy']), s('thick', 'series', ['Comedy']), s('pride', 'movie', ['Drama', 'Comedy']), s('standup', 'movie', ['Comedy']), s('kids', 'series', ['Kids', 'Comedy']), s('peer', 'series', ['Drama']), s('thick', 'series', ['Comedy'])];
  const out = hiddenGems(items, scores, { noise: { series: ['Kids'] } }).map((x) => x.id);
  assert.deepEqual(out, ['thick', 'detect', 'peer', 'pride']);
  // detect and peer score the same: your genre wins, and what people who watched your shows also watched wins more.
  const order = (o: Parameters<typeof hiddenGems>[2]) => { const ids = hiddenGems(items, scores, o).map((x) => x.id); return ids.indexOf('detect') < ids.indexOf('peer') ? 'detect' : 'peer'; };
  assert.equal(order({ taste: ['Comedy'] }), 'detect');
  assert.equal(order({ taste: ['Comedy'], cowatched: new Set(['peer']) }), 'peer');
});

test('imdbFloor drops what IMDb pans and keeps what it has not judged yet', () => {
  const scores = new Map([['bad', { rating: 4.1, votes: 9000 }], ['good', { rating: 7.9, votes: 20_000 }]]);
  const m = (id: string): MetaPreview => ({ id, type: 'series', name: id });
  assert.deepEqual(imdbFloor([m('bad'), m('good'), m('fresh')], scores, 6.5).map((x) => x.id), ['good', 'fresh']);
});
