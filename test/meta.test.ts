import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Episode, Meta } from '../server/types.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const { nextEpisode, parseVideoId, search, meta, catalog, hasMeta, hasMetas, upstreamNotFound, runtimeSeconds, runtimeOf } = await import('../server/meta.ts');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 1, 12);
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();
const ep = (season: number, episode: number, released?: string): Episode => ({ id: `tt1:${season}:${episode}`, season, episode, title: `E${episode}`, released });
const show = (videos: Episode[]): Meta => ({ id: 'tt1', type: 'series', name: 'Show', videos });

test('nextEpisode: the following episode, across a season break', () => {
  const m = show([ep(1, 1, iso(-30)), ep(1, 2, iso(-23)), ep(2, 1, iso(-2)), ep(2, 2)]);
  assert.equal(nextEpisode(m, 'tt1:1:1', NOW)?.id, 'tt1:1:2');
  assert.equal(nextEpisode(m, 'tt1:1:2', NOW)?.id, 'tt1:2:1');   // season rollover
  assert.equal(nextEpisode(m, 'tt1:2:1', NOW)?.id, 'tt1:2:2');   // no release date: assumed out
});

test('nextEpisode: nothing after the last episode, or when the next is not out yet', () => {
  const m = show([ep(1, 1, iso(-14)), ep(1, 2, iso(-7)), ep(1, 3, iso(3))]);
  assert.equal(nextEpisode(m, 'tt1:1:1', NOW)?.id, 'tt1:1:2');
  assert.equal(nextEpisode(m, 'tt1:1:2', NOW), undefined);        // airs in three days
  assert.equal(nextEpisode(m, 'tt1:1:2', NOW + 4 * DAY)?.id, 'tt1:1:3');   // out once now passes its date
  assert.equal(nextEpisode(show([ep(1, 1, iso(-14)), ep(1, 2, iso(-7))]), 'tt1:1:2', NOW), undefined);
  assert.equal(nextEpisode(m, 'tt1:9:9', NOW), undefined);         // not in the list
  assert.equal(nextEpisode({ id: 'tt2', type: 'movie', name: 'Film' }, 'tt2', NOW), undefined);
});

test('nextEpisode: season 0 specials are skipped, and a special has no next', () => {
  // meta() sorts by season, so specials come first
  const m = show([ep(0, 1, iso(-100)), ep(0, 2, iso(-50)), ep(1, 1, iso(-40)), ep(1, 2, iso(-30))]);
  assert.equal(nextEpisode(m, 'tt1:1:1', NOW)?.id, 'tt1:1:2');
  assert.equal(nextEpisode(m, 'tt1:1:2', NOW), undefined);         // does not wrap to a special
  assert.equal(nextEpisode(m, 'tt1:0:1', NOW), undefined);
  const late = show([ep(1, 1, iso(-40)), ep(1, 2, iso(-30)), ep(0, 1, iso(-20)), ep(2, 1, iso(-10))]);
  assert.equal(nextEpisode(late, 'tt1:1:2', NOW)?.id, 'tt1:2:1');  // a special listed between seasons is stepped over
});

test('parseVideoId: movie, series episode and a file in a pasted magnet', () => {
  assert.deepEqual(parseVideoId('tt0111161'), { metaId: 'tt0111161' });
  assert.deepEqual(parseVideoId('tt0903747:2:5'), { metaId: 'tt0903747', season: 2, episode: 5 });
  assert.deepEqual(parseVideoId('tt0903747:0:1'), { metaId: 'tt0903747', season: 0, episode: 1 });
  assert.deepEqual(parseVideoId('magnet:abcdef0123456789abcdef0123456789abcdef01:3'), { metaId: 'magnet:abcdef0123456789abcdef0123456789abcdef01' });
  assert.deepEqual(parseVideoId('magnet:abcdef0123456789abcdef0123456789abcdef01'), { metaId: 'magnet:abcdef0123456789abcdef0123456789abcdef01' });
});

test('search alternates movies and series, and one side failing still returns the other', async () => {
  const real = globalThis.fetch;
  let seriesDown = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const metas = (t: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${t}${i}`, type: t, name: `${t} ${i}` }));
    if (url.includes('/catalog/movie/')) return new Response(JSON.stringify({ metas: metas('movie', 3) }));
    if (url.includes('/catalog/series/')) return seriesDown ? new Response('', { status: 503 }) : new Response(JSON.stringify({ metas: metas('series', 1) }));
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    assert.deepEqual((await search('first query')).map((m) => m.id), ['movie0', 'series0', 'movie1', 'movie2']);
    seriesDown = true;
    assert.deepEqual((await search('second query')).map((m) => m.id), ['movie0', 'movie1', 'movie2']);
    assert.deepEqual(await search('   '), []);
  } finally { globalThis.fetch = real; }
});

test('meta: past its ttl a show is still served while Cinemeta is down, and refreshed once it is back', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const real = globalThis.fetch;
  let name = 'Old name'; let down = false; let calls = 0;
  globalThis.fetch = (async () => { calls++; return down ? new Response('', { status: 503 }) : new Response(JSON.stringify({ meta: { id: 'tt77', type: 'series', name } })); }) as typeof fetch;
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };   // the background refresh streams a body
  try {
    assert.equal((await meta('series', 'tt77')).name, 'Old name');
    t.mock.timers.tick(DAY / 2);
    down = true; name = 'New name';
    assert.equal((await meta('series', 'tt77')).name, 'Old name');   // served stale, not dropped
    await settle();
    assert.equal(calls, 2);
    down = false;
    assert.equal((await meta('series', 'tt77')).name, 'Old name');   // within a minute of the failure: no new call
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(60_000);
    assert.equal((await meta('series', 'tt77')).name, 'Old name');   // still stale, this call refreshes
    await settle();
    assert.equal((await meta('series', 'tt77')).name, 'New name');
    assert.equal(calls, 3);
  } finally { globalThis.fetch = real; }
});

test('hasMeta and hasMetas: only a named meta or a catalog with rows is worth caching', () => {
  assert.equal(hasMeta({ meta: { id: 'tt1', type: 'movie', name: 'Film' } }), true);
  assert.equal(hasMeta({ meta: { id: 'tt0000000', type: 'movie' } as never }), false);   // what Cinemeta answers for an id it does not know
  assert.equal(hasMeta({ meta: null }), false);
  assert.equal(hasMeta({}), false);
  assert.equal(hasMeta(undefined), false);
  assert.equal(hasMetas({ metas: [{ id: 'tt1', type: 'movie', name: 'Film' }] }), true);
  assert.equal(hasMetas({ metas: [] }), false);   // what Cinemeta answers past the last page or for an unknown genre
  assert.equal(hasMetas({ metas: null }), false);
  assert.equal(hasMetas({}), false);
  assert.equal(hasMetas(null), false);
});

test('an empty refresh never replaces a good meta or catalog', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const real = globalThis.fetch;
  let empty = false; let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls++;
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/catalog/')) return new Response(JSON.stringify(empty ? { metas: [], hasMore: false } : { metas: [{ id: 'tt5', type: 'movie', name: 'Kept' }] }));
    return new Response(JSON.stringify(empty ? { meta: { id: 'tt88', type: 'movie' } } : { meta: { id: 'tt88', type: 'movie', name: 'Kept' } }));
  }) as typeof fetch;
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  try {
    assert.equal((await meta('movie', 'tt88')).name, 'Kept');
    assert.deepEqual((await catalog('movie', 'top', { genre: 'Empty refresh' })).map((m) => m.name), ['Kept']);
    t.mock.timers.tick(DAY / 2);
    empty = true;
    assert.equal((await meta('movie', 'tt88')).name, 'Kept');   // stale, and this call refreshes
    assert.equal((await catalog('movie', 'top', { genre: 'Empty refresh' })).length, 1);
    await settle();
    assert.equal(calls, 4);
    t.mock.timers.tick(60_000);
    assert.equal((await meta('movie', 'tt88')).name, 'Kept');   // the empty answers were refused, not cached
    assert.equal((await catalog('movie', 'top', { genre: 'Empty refresh' })).length, 1);
    await settle();
    assert.equal(calls, 6);
  } finally { globalThis.fetch = real; }
});

test('meta: a title Cinemeta does not know is a 404 that names no URL; Cinemeta down stays a plain failure', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/tt404')) return new Response('<pre>Cannot GET /movie/tt404.json</pre>', { status: 404, statusText: 'Not Found' });
    if (url.includes('/tt500')) return new Response('', { status: 503, statusText: 'Service Unavailable' });
    if (url.includes('/ttnoname')) return new Response(JSON.stringify({ meta: { id: 'ttnoname', type: 'movie' } }));
    return new Response('{}');   // what Cinemeta answers for some ids it does not know
  }) as typeof fetch;
  const notFound = (e: unknown) => (e as { status?: number }).status === 404 && (e as Error).message === 'Kino could not find this title';
  try {
    for (const id of ['tt404', 'ttempty', 'ttnoname']) await assert.rejects(meta('movie', id), notFound, id);
    await assert.rejects(meta('movie', 'tt500'), (e: unknown) => (e as { status?: number }).status === undefined && /^503 /.test((e as Error).message));
  } finally { globalThis.fetch = real; }
});

test('upstreamNotFound: the status the upstream answered, never the text', () => {
  assert.equal(upstreamNotFound(Object.assign(new Error('404 Not Found for https://v3-cinemeta.strem.io/meta/movie/tt1.json'), { upstreamStatus: 404 })), true);
  const others = [Object.assign(new Error('x'), { upstreamStatus: 503 }), new Error('404 Not Found for https://x'), Object.assign(new Error('Gone'), { status: 404 }), new Error('fetch failed')];
  for (const e of others) assert.equal(upstreamNotFound(e), false, e.message);
});

test('runtimeSeconds: Cinemeta\'s running time in seconds, only when it is a believable length', () => {
  const cases: [string | undefined, number | undefined][] = [
    ['51 min', 51 * 60], ['1h 52min', 112 * 60], ['2 h', 7200], ['1h52m', 112 * 60], ['95', 95 * 60], ['120 minutes', 7200],
    [undefined, undefined], ['', undefined], ['N/A', undefined], ['2 min', undefined], ['900 min', undefined],
  ];
  for (const [s, want] of cases) assert.equal(runtimeSeconds(s), want, String(s));
});

test('runtimeOf: from the title\'s meta (an episode asks for its show), nothing for an id Cinemeta does not hold or a slow answer', async () => {
  const real = globalThis.fetch; const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); asked.push(url);
    if (url.includes('tt4401')) return new Promise<Response>(() => undefined);   // never answers
    return new Response(JSON.stringify({ meta: { id: 'tt4400', type: 'series', name: 'Show', runtime: '44 min' } }));
  }) as typeof fetch;
  try {
    assert.equal(await runtimeOf('series', 'tt4400:2:3'), 44 * 60);
    assert.ok(asked[0].endsWith('/meta/series/tt4400.json'));
    assert.equal(await runtimeOf('movie', 'kitsu:123'), undefined);
    assert.equal(await runtimeOf('movie', 'magnet:abc'), undefined);
    assert.equal(asked.length, 1, 'only tt ids are looked up');
    assert.equal(await runtimeOf('movie', 'tt4401', 20), undefined, 'a slow Cinemeta does not hold the sources up');
  } finally { globalThis.fetch = real; }
});
