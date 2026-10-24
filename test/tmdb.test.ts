import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPreview, withStills, limiter, discover, recommendations, episodeStills, lookup, discoverQuery, genreId } from '../server/tmdb.ts';

test('toPreview maps a TMDB trending item to a Kino preview keyed by IMDb id', () => {
  const p = toPreview({ id: 1, title: ' Sandstorm ', poster_path: '/p.jpg', backdrop_path: '/b.jpg', release_date: '2026-03-01', overview: 'Sand.' }, 'movie', 'tt1');
  assert.deepEqual(p, { id: 'tt1', type: 'movie', name: 'Sandstorm', poster: 'https://image.tmdb.org/t/p/w342/p.jpg', background: 'https://image.tmdb.org/t/p/w1280/b.jpg', year: '2026', description: 'Sand.' });
  const s = toPreview({ id: 2, name: 'Harbor', first_air_date: '2023-05-05', poster_path: null }, 'tv', 'tt2');
  assert.equal(s.type, 'series'); assert.equal(s.year, '2023'); assert.equal(s.poster, undefined);
  assert.deepEqual(toPreview({ id: 3, name: 'Detectorists', genre_ids: [35, 18, 99999] }, 'tv', 'tt3').genres, ['Comedy', 'Drama']);
});

test('withStills swaps in TMDB stills where it has them and keeps the rest', () => {
  const eps = [{ id: 'tt1:4:1', season: 4, episode: 1, title: 'a', thumbnail: 'meta/1.jpg' }, { id: 'tt1:4:2', season: 4, episode: 2, title: 'b', thumbnail: 'meta/2.jpg' }, { id: 'tt1:4:3', season: 4, episode: 3, title: 'c' }];
  const out = withStills(eps, new Map([['4:2', 'tmdb/2.jpg'], ['4:3', 'tmdb/3.jpg']]));
  assert.deepEqual(out.map((e) => e.thumbnail), ['meta/1.jpg', 'tmdb/2.jpg', 'tmdb/3.jpg']);
  assert.equal(eps[1].thumbnail, 'meta/2.jpg');   // input untouched
});

test('discoverQuery spells the filters the way TMDB does, per kind', () => {
  const q = discoverQuery('movie', { since: '2025-09-17', minVotes: 100, minRating: 6.5 });
  assert.equal(q['primary_release_date.gte'], '2025-09-17'); assert.equal(q['vote_count.gte'], 100); assert.equal(q.sort_by, 'popularity.desc'); assert.equal(q.page, 1);
  const t = discoverQuery('tv', { withoutGenres: [16, 10762], maxVotes: 2500, page: 2, language: 'en', until: '2025-09-17' });
  assert.equal(t['first_air_date.gte'], undefined); assert.equal(t['first_air_date.lte'], '2025-09-17'); assert.equal(t.without_genres, '16,10762'); assert.equal(t['vote_count.lte'], 2500); assert.equal(t.page, 2); assert.equal(t.with_original_language, 'en');
  assert.equal(discoverQuery('tv', { anyGenre: [35, 80] }).with_genres, '35|80');   // any of them, not all
  assert.equal(discoverQuery('tv', { anyGenre: [] }).with_genres, undefined);
  assert.equal(discoverQuery('tv', { genre: 18, anyGenre: [35] }).with_genres, 18);
});

test('genreId matches Cinemeta names to TMDB names loosely', () => {
  const tv = [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 35, name: 'Comedy' }, { id: 10759, name: 'Action & Adventure' }];
  assert.equal(genreId(tv, 'Comedy'), 35);
  assert.equal(genreId(tv, 'Sci-Fi'), 10765);
  assert.equal(genreId(tv, 'Fantasy'), 10765);
  assert.equal(genreId(tv, 'Action'), 10759);
  assert.equal(genreId(tv, 'Western'), undefined);
});

// ---- network behaviour, with fetch stubbed ----
type Reply = { status?: number; body?: unknown };
function stubFetch(route: (url: string) => Reply): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input); calls.push(url);
    const r = route(url);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('limiter never runs more than its limit, even when a newcomer arrives as a slot frees up', async () => {
  for (let hops = 0; hops < 6; hops++) {
    const gate = limiter(1);
    let now = 0, peak = 0;
    const run = (p: () => Promise<unknown>) => async () => { now++; peak = Math.max(peak, now); try { return await p(); } finally { now--; } };
    let release!: () => void; const first = new Promise<void>((r) => { release = r; });
    const slow = () => new Promise<void>((r) => setTimeout(r, 5));
    const all: Promise<unknown>[] = [gate(run(() => first)), gate(run(slow))];
    release();
    let hop = Promise.resolve(); for (let i = 0; i < hops; i++) hop = hop.then(() => undefined);
    all.push(hop.then(() => gate(run(slow))));
    await Promise.all(all);
    assert.equal(peak, 1, `hops ${hops}`);
  }
});

test('a failed IMDb id lookup is not remembered, so the title comes back on the next shelf', async () => {
  let failIds = true;
  const f = stubFetch((url) => {
    if (url.includes('/discover/movie')) return { body: { results: [{ id: 9001, title: 'Nine', vote_count: 500, vote_average: 7.5 }] } };
    if (url.includes('/movie/9001/external_ids')) return failIds ? { status: 429 } : { body: { imdb_id: 'tt9001' } };
    return { status: 404 };
  });
  try {
    assert.deepEqual((await discover('movie', 'k', { page: 91 })).map((m) => m.id), []);
    failIds = false;
    assert.deepEqual((await discover('movie', 'k', { page: 92 })).map((m) => m.id), ['tt9001']);
  } finally { f.restore(); }
});

test('recommendations that fail outright are not cached as "none"', async () => {
  let down = true;
  const f = stubFetch((url) => {
    if (url.includes('/find/tt8001')) return { body: { movie_results: [{ id: 8001 }] } };
    if (url.includes('/movie/8001/recommendations')) return down ? { status: 503 } : { body: { results: url.includes('page=1') ? [{ id: 8002, title: 'Two', vote_count: 900 }] : [] } };
    if (url.includes('/movie/8002/external_ids')) return { body: { imdb_id: 'tt8002' } };
    return { status: 404 };
  });
  try {
    await assert.rejects(recommendations('movie', 'tt8001', 'k'));
    down = false;
    assert.deepEqual((await recommendations('movie', 'tt8001', 'k')).map((m) => m.id), ['tt8002']);
  } finally { f.restore(); }
});

test('episode stills for a long show ask TMDB for its newest twenty seasons', async () => {
  const f = stubFetch((url) => {
    if (url.includes('/find/tt7001')) return { body: { tv_results: [{ id: 7001 }] } };
    if (url.includes('/tv/7001?')) return { body: { 'season/25': { episodes: [{ season_number: 25, episode_number: 1, still_path: '/s.jpg' }] } } };
    return { status: 404 };
  });
  try {
    const m = await episodeStills('tt7001', Array.from({ length: 26 }, (_, i) => i), 'k');   // specials plus 25 seasons
    const asked = decodeURIComponent(f.calls.find((u) => u.includes('/tv/7001?'))!.split('append_to_response=')[1]).split(',');
    assert.equal(asked.length, 20); assert.equal(asked[0], 'season/6'); assert.equal(asked.at(-1), 'season/25');
    assert.equal(m.get('25:1'), 'https://image.tmdb.org/t/p/w780/s.jpg');
  } finally { f.restore(); }
});

test('episode stills reuse the cached IMDb to TMDB lookup instead of asking /find again', async () => {
  const f = stubFetch((url) => {
    if (url.includes('/find/tt7002')) return { body: { tv_results: [{ id: 7002, original_language: 'en' }] } };
    if (url.includes('/tv/7002?')) return { body: { 'season/1': { episodes: [{ season_number: 1, episode_number: 2, still_path: '/e.jpg' }] } } };
    return { status: 404 };
  });
  try {
    assert.deepEqual(await lookup('series', 'tt7002', 'k'), { id: 7002, lang: 'en' });
    const m = await episodeStills('tt7002', [0, 1], 'k');
    assert.equal(m.get('1:2'), 'https://image.tmdb.org/t/p/w780/e.jpg');
    assert.equal(f.calls.filter((u) => u.includes('/find/')).length, 1);
  } finally { f.restore(); }
});
