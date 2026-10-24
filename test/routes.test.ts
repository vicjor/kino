import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type WebTorrent from 'webtorrent';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const { default: express } = await import('express');
const { api } = await import('../server/routes/index.ts');
const util = await import('../server/routes/util.ts');
const { jsonErrors, apiNotFound } = await import('../server/errors.ts');
const playRoutes = await import('../server/routes/play.ts');
const store = await import('../server/store.ts');
const torrent = await import('../server/torrent.ts');
const scrape = await import('../server/scrape.ts');
const castRoutes = await import('../server/routes/cast.ts');
store.load(path.join(DIR, 'state.json'));
store.update((s) => { s.settings.minFreeBytes = 0; });

// A fake webtorrent client that records every add: no test here ever joins a real swarm.
class FakeTorrent extends EventEmitter {
  files: { name: string; path: string; length: number; deselect: () => void }[] = []; name = ''; destroyed = false; magnetURI = '';
  constructor(public infoHash: string) { super(); }
  meta(...names: string[]) { this.name = names[0]; this.files = names.map((n) => ({ name: n, path: n, length: 1000, deselect: () => undefined })); this.emit('metadata'); }
  destroy(_o?: unknown, cb?: () => void) { this.destroyed = true; if (cb) setImmediate(cb); }
}
const added: FakeTorrent[] = [];
torrent.setClientForTests({ add: (magnet: string) => { const t = new FakeTorrent(torrent.infoHashOf(magnet)!); added.push(t); return t; }, destroy: (cb?: () => void) => cb?.() } as unknown as WebTorrent);
// Fake trackers: no test here ever asks a public one. They answer from `trackerSeeds` and note every batch asked.
const trackerSeeds = new Map<string, number>();
const scraped: string[][] = [];
scrape.setScrapeForTests(async (hashes) => { scraped.push(hashes); return new Map(hashes.filter((h) => trackerSeeds.has(h)).map((h) => [h, trackerSeeds.get(h)!])); });

// The API as server/index.ts mounts it: JSON parser and error handler on the app, the router under /api, then the /api 404.
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', api);
app.use('/api', apiNotFound);
app.use(jsonErrors);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(async () => { for (const c of 'cd') await torrent.remove(c.repeat(40)); torrent.setClientForTests(null); scrape.setScrapeForTests(null); store.flushSync(); server.closeAllConnections(); server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => undefined) as Record<string, unknown> | null | undefined };
};

test('a malformed JSON body on an API route is a JSON 400', async () => {
  const r = await call('PUT', '/settings', '{"autoNext":');
  assert.equal(r.status, 400);
  assert.equal(typeof r.body?.error, 'string');
});

test('progress: bad positions or type are a 400 and save nothing; good ones save, beacon included', async () => {
  for (const b of [{ pos: 'abc' }, { pos: -5 }, { dur: 'x' }, { type: 'show' }, { pos: 10, season: 'one' }]) {
    const r = await call('PUT', '/progress/tt0000001', b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(store.getProgress('tt0000001'), undefined);
  const ok = await call('PUT', '/progress/tt0000001:1:2', { pos: 100, dur: 2000, name: 'A S1 E2' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body?.metaId, ok.body?.type, ok.body?.season, ok.body?.pos], ['tt0000001', 'series', 1, 100]);
  const early = await call('PUT', '/progress/tt0000001:1:2', { pos: 0, dur: 2000 });
  assert.equal(early.body?.pos, 100, 'an early position keeps the real one');
  const r = await fetch(`${base}/progress/tt0000001:1:2`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ pos: 200, dur: 2000 }) });
  assert.equal(r.status, 200);
  assert.equal(store.getProgress('tt0000001:1:2')?.pos, 200);
  const plain = await fetch(`${base}/restore`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ progress: {} }) });
  assert.equal(plain.status, 400, 'text/plain is read as JSON on the beacon route only');
  const bad = await fetch(`${base}/progress/tt0000001:1:2`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"pos":' });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error, 'string');
  const marked = await call('PUT', '/progress/tt0000001:1:2', { pos: 1, dur: 1 });
  assert.deepEqual([marked.body?.pos, marked.body?.dur], [1, 1], 'mark as watched passes');
});

test('cast: missing ids, a garbled seek time or volume are a 400 before anything reaches a TV', async () => {
  for (const [p, b] of [
    ['/cast/play', {}], ['/cast/play', { deviceId: 'tv' }], ['/cast/play', { infoHash: 'ab'.repeat(20) }], ['/cast/play', { deviceId: '', infoHash: 'x' }],
    ['/cast/play', { deviceId: 'tv', infoHash: 'ab'.repeat(20), startTime: 'soon' }], ['/cast/play', { deviceId: 'tv', infoHash: 'ab'.repeat(20), videoId: '__proto__' }],
    ['/cast/seek', {}], ['/cast/seek', { time: 'abc' }], ['/cast/seek', { time: null }], ['/cast/seek', { time: '30' }],
    ['/cast/volume', {}], ['/cast/volume', { level: 'loud' }], ['/cast/volume', { level: '0.5' }], ['/cast/volume', { muted: 'yes' }],
  ] as const) {
    const r = await call('POST', p, b);
    assert.equal(r.status, 400, `${p} ${JSON.stringify(b)}`);
    assert.equal(typeof r.body?.error, 'string');
  }
  // Valid but nothing is casting: a no-op, not an error.
  assert.equal((await call('POST', '/cast/seek', { time: 30 })).status, 200);
  assert.equal((await call('POST', '/cast/volume', { level: 0.5 })).status, 200);
  assert.equal((await call('POST', '/cast/volume', { muted: true })).status, 200);
  // A receiver Kino does not know: a 404 in words, not a 500.
  assert.deepEqual(await call('POST', '/cast/receivers/nope/pause'), { status: 404, body: { error: 'Cast device not found' } });
  assert.deepEqual(await call('POST', '/cast/receivers/dlna:nope/volume', { level: 0.5 }), { status: 404, body: { error: 'TV not found' } });
});

test('seekTime and volumeChange: the body checks every cast route shares', () => {
  const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return (e as { status?: number }).status; } };
  for (const [v, want] of [[0, 0], [30, 30], [12.5, 12.5]] as const) assert.equal(castRoutes.seekTime(v), want);
  for (const v of [undefined, null, '30', 'abc', -1, -0.5, NaN, Infinity, -Infinity, true, [30], { t: 30 }]) assert.equal(status(() => castRoutes.seekTime(v)), 400, String(v));
  for (const [b, want] of [
    [{ level: 0.5 }, { level: 0.5 }], [{ level: 0 }, { level: 0 }], [{ level: 1 }, { level: 1 }],
    [{ level: 5 }, { level: 1 }], [{ level: -2 }, { level: 0 }], [{ muted: true }, { muted: true }], [{ muted: false }, { muted: false }],
    [{ level: 0.3, muted: false }, { level: 0.3, muted: false }], [{ level: null, muted: true }, { muted: true }],
  ] as const) assert.deepEqual(castRoutes.volumeChange(b), want, JSON.stringify(b));
  for (const b of [undefined, null, {}, [], 'loud', { level: 'loud' }, { level: '0.5' }, { level: NaN }, { level: Infinity }, { muted: 'yes' }, { muted: 1 }, { level: 0.5, muted: 'no' }]) {
    assert.equal(status(() => castRoutes.volumeChange(b)), 400, JSON.stringify(b));
  }
});

test('cast receivers: a garbled level, mute or seek time is a 400 before the device is looked up', async () => {
  for (const [cmd, b] of [
    ['volume', {}], ['volume', { level: 'loud' }], ['volume', { level: '0.5' }], ['volume', { muted: 'yes' }], ['volume', { level: 0.5, muted: 1 }],
    ['seek', {}], ['seek', { time: 'abc' }], ['seek', { time: null }], ['seek', { time: '30' }], ['seek', { time: -5 }],
  ] as const) {
    for (const id of ['nope', 'dlna:nope']) {
      const r = await call('POST', `/cast/receivers/${id}/${cmd}`, b);
      assert.equal(r.status, 400, `${id} ${cmd} ${JSON.stringify(b)}`);
      assert.equal(typeof r.body?.error, 'string');
    }
  }
  // Good bodies get through the checks (a loud level is turned down to 1, not refused) to the device lookup.
  for (const [cmd, b] of [['volume', { level: 5 }], ['volume', { muted: false }], ['seek', { time: 0 }], ['pause', { time: 'ignored' }], ['stop', undefined]] as const) {
    assert.equal((await call('POST', `/cast/receivers/nope/${cmd}`, b)).status, 404, `${cmd} ${JSON.stringify(b)}`);
  }
  assert.equal((await call('POST', '/cast/seek', { time: -5 })).status, 400, 'Kino\'s own cast too');
});

test('body checks: an index that is not a whole number, a text offset, an odd subtitle id are a 400', async () => {
  for (const [p, b] of [
    ['/cast/subtitle', { subId: 5 }], ['/cast/subtitle', { subId: { id: 'x' } }], ['/cast/subtitle', { subId: 'x', offsetMs: '500' }],
    ['/cast/source', { infoHash: 'ab'.repeat(20), fileIdx: 'x' }], ['/cast/source', { infoHash: 'ab'.repeat(20), fileIdx: -2 }],
    ['/subs/sync', { id: 's', infoHash: 'd'.repeat(40), fileIdx: 'a' }], ['/subs/sync', { id: 's', infoHash: 'd'.repeat(40), fileIdx: 0.5 }], ['/subs/sync', { id: 7, infoHash: 'd'.repeat(40), fileIdx: 0 }],
  ] as const) {
    const r = await call('POST', p, b);
    assert.equal(r.status, 400, `${p} ${JSON.stringify(b)}`);
    assert.equal(typeof r.body?.error, 'string');
  }
  // Valid but nothing is casting: a no-op, not an error.
  assert.equal((await call('POST', '/cast/subtitle', { subId: null, offsetMs: 500 })).status, 200);
  assert.equal((await call('POST', '/cast/subtitle', {})).status, 200);
});

test('subtitle sync refuses a hash Kino never chose, and joins no swarm', async () => {
  const n = added.length; const h = 'e'.repeat(40);
  const r = await call('POST', '/subs/sync', { id: 's', infoHash: h, fileIdx: 0 });
  assert.equal(r.status, 404);
  assert.equal(added.length, n, 'nothing added to the client');
  assert.equal(torrent.isKnown(h), false);
});

test('settings: a wrong field refuses the whole change in words; good ones save', async () => {
  const before = (await call('GET', '/settings')).body!;
  for (const b of [{ haWebhookUrl: 'homeassistant.local:8123/x', autoNext: !before.autoNext }, { addons: ['not a link'] }, { cacheCapBytes: 0 }, { minFreeBytes: '3' }]) {
    const r = await call('PUT', '/settings', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(String(r.body?.error), /\.$/);
  }
  assert.deepEqual((await call('GET', '/settings')).body, before, 'nothing changed');
  const r = await call('PUT', '/settings', { haWebhookUrl: 'http://ha.local/api/webhook/k', subFontSize: 400 });
  assert.deepEqual([r.status, r.body?.haWebhookUrl, r.body?.subFontSize], [200, 'http://ha.local/api/webhook/k', 250]);
  const cleared = await call('PUT', '/settings', { haWebhookUrl: '' });
  assert.equal('haWebhookUrl' in cleared.body!, false);
});

test('restore: not a backup is a 400; a backup is merged through the same rules', async () => {
  assert.equal((await call('POST', '/restore', { following: [] })).status, 400);
  assert.equal((await call('POST', '/restore', [])).status, 400);
  const cap = store.getState().settings.cacheCapBytes;
  const r = await call('POST', '/restore', { settings: { cacheCapBytes: 'all', addons: ['https://x.example/manifest.json'] }, progress: { tt0000009: { videoId: 'tt0000009', metaId: 'tt0000009', type: 'movie', pos: 60, dur: 600, updatedAt: 1, name: 'R' } }, credits: { tt0000009: [45] } });
  assert.equal(r.status, 200);
  assert.equal(store.getState().settings.cacheCapBytes, cap);
  assert.ok(store.getState().settings.addons.includes('https://x.example/manifest.json'));
  assert.equal(store.getProgress('tt0000009')?.pos, 60);
  assert.deepEqual(store.getState().credits.tt0000009, [45]);
});

test('prototype keys in a path, query or body are a 400 and change nothing', async () => {
  const before = Object.keys(store.getState().progress).length;
  for (const id of ['__proto__', 'constructor', '__proto__:1:2', 'toString']) {
    for (const m of ['GET', 'PUT', 'POST', 'DELETE']) {
      const r = await call(m, `/progress/${encodeURIComponent(id)}`, m === 'PUT' || m === 'POST' ? { pos: 100, dur: 1000 } : undefined);
      assert.equal(r.status, 400, `${m} ${id}`);
      assert.match(String(r.body?.error), /video id/);
    }
  }
  assert.equal((await call('POST', '/credits/learn', { metaId: '__proto__', offset: 60 })).status, 400);
  assert.equal((await call('POST', '/credits/learn', { metaId: 'constructor', offset: 60 })).status, 400);
  assert.equal((await call('POST', '/intro/learn', { metaId: '__proto__', start: 60, end: 150 })).status, 400);
  const streams = await call('GET', '/streams/series/__proto__:1:1');
  assert.deepEqual([streams.status, streams.body?.error], [400, 'Not a valid video id'], 'every router checks :videoId, not only progress');
  assert.equal((await call('GET', '/credits?infoHash=ab&fileIdx=0&metaId=__proto__')).status, 400);
  assert.equal((await call('GET', '/intro?infoHash=ab&fileIdx=0&videoId=constructor:1:1')).status, 400);
  assert.equal(Object.keys(store.getState().progress).length, before);
  assert.equal(Object.getPrototypeOf(store.getState().credits), Object.prototype);
  assert.equal(Object.getPrototypeOf(store.getState().progress), Object.prototype);
  const ok = await call('POST', '/credits/learn', { metaId: 'tt0944947', offset: 60 });
  assert.deepEqual([ok.status, ok.body?.offsets], [200, [60]]);
});

test('GETs that would load a torrent refuse a hash Kino never chose, and join no swarm', async (ctx) => {
  const h = 'c'.repeat(40);
  util.setPlayRaceMsForTests(20); ctx.after(() => util.setPlayRaceMsForTests(2000));   // /subs waits this long for a racing play
  for (const p of [`/torrent/${h}/files`, `/subs?infoHash=${h}&fileIdx=0`, `/credits?infoHash=${h}&fileIdx=0`, `/intro?infoHash=${h}&fileIdx=0`, `/torrent/${h.toUpperCase()}/files`, '/torrent/..%2F..%2Fx/files']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, p);
    assert.equal(typeof r.body?.error, 'string', 'a rejected async handler still answers JSON');
  }
  assert.equal(added.length, 0, 'nothing added to the client');
  assert.equal(torrent.isKnown(h), false);
});

test('a known hash still loads: subtitles asked in the same breath as the play, then the file list', async (ctx) => {
  const h = 'd'.repeat(40);
  util.setPlayRaceMsForTests(30_000); ctx.after(() => util.setPlayRaceMsForTests(2000));   // a cap it must not sit out
  const subs = call('GET', `/subs?infoHash=${h}&type=movie`);
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  const play = torrent.ensure(h);   // what POST /api/play does, a moment after the subtitle request
  assert.equal(added.length, 1);
  added[0].meta('Film.mkv', 'Film.en.srt');
  await play;
  const r = await subs;
  assert.ok(Date.now() - started < 5000, 'answered once the play started loading, not at the cap');
  assert.equal(r.status, 200);
  assert.deepEqual((r.body?.tracks as { origin: string }[]).map((x) => x.origin), ['torrent']);
  const f = await call('GET', `/torrent/${h}/files`);
  assert.equal(f.status, 200);
  assert.deepEqual((f.body?.files as { name: string }[]).map((x) => x.name), ['Film.mkv', 'Film.en.srt']);
  assert.equal(added.length, 1, 'the loaded torrent is reused');
});

test('async handlers need no wrapper: a rejection keeps its status as JSON; a garbled magnet is a 400 that adds nothing', async () => {
  const n = added.length;
  for (const [p, b] of [['/torrent/add', { magnet: 'not a magnet' }], ['/torrent/add', {}], ['/play', { magnet: 'magnet:?xt=urn:btih:nope' }]] as const) {
    const r = await call('POST', p, b);
    assert.deepEqual([r.status, r.body?.error], [400, 'Not a valid magnet link or info hash'], `${p} ${JSON.stringify(b)}`);
  }
  const missing = await call('POST', '/cast/play', {});
  assert.deepEqual([missing.status, missing.body?.error], [400, 'deviceId required']);
  assert.equal(added.length, n, 'no add for a garbled magnet');
});

test('an unknown /api path is a JSON 404 for GET and POST, never Express\'s HTML page', async () => {
  for (const [method, p] of [['GET', '/no-such-thing'], ['POST', '/no-such-thing'], ['GET', '/meta/movie'], ['POST', '/hls/x/y/z']] as const) {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.match(r.headers.get('content-type') || '', /application\/json/, `${method} ${p}`);
    assert.deepEqual(await r.json(), { error: 'Kino could not find that. Reload the page to get the latest version.' });
  }
});

test('a title Cinemeta does not know is a 404 in words, with no upstream URL', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) return real(input, init);
    if (url.includes('/meta/movie/tt0000404')) return new Response('<pre>Cannot GET /movie/tt0000404.json</pre>', { status: 404, statusText: 'Not Found' });
    return new Response('{}');
  }) as typeof fetch;
  try {
    for (const id of ['tt0000404', 'tt0000405']) {
      const r = await call('GET', `/meta/movie/${id}`);
      assert.deepEqual([r.status, r.body], [404, { error: 'Kino could not find this title' }], id);
    }
  } finally { globalThis.fetch = real; }
});

test('play: a fileIdx or audioTrack that is not a whole number from 0 is a 400 before any torrent loads', async () => {
  const n = added.length; const infoHash = 'f'.repeat(40);
  for (const b of [{ fileIdx: -1 }, { fileIdx: 1.5 }, { fileIdx: '2' }, { fileIdx: true }, { audioTrack: -1 }, { audioTrack: 0.5 }, { audioTrack: 'eng' }]) {
    const r = await call('POST', '/play', { infoHash, target: 'browser', ...b });
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(String(r.body?.error), /^(fileIdx|audioTrack) must be a whole number from 0$/);
  }
  const inf = await call('POST', '/play', `{"infoHash":"${infoHash}","fileIdx":1e999}`);
  assert.equal(inf.status, 400, 'Infinity from JSON');
  assert.deepEqual(Object.values(await call('POST', '/play')), [400, { error: 'infoHash or magnet required' }], 'no body at all is a 400, not a TypeError');
  assert.equal(added.length, n, 'nothing added to the client');
  assert.equal(torrent.isKnown(infoHash), false);
});

test('hls seek: a time that is no finite number is a 400, checked before the session', async () => {
  for (const body of ['{"time":"abc"}', '{"time":"12"}', '{"time":null}', '{}', '{"time":1e999}', '{"time":-1e999}']) {
    const r = await call('POST', '/hls/nosuch/seek', body);
    assert.deepEqual([r.status, r.body?.error], [400, 'time must be a number of seconds'], body);
  }
  assert.equal((await call('POST', '/hls/nosuch/seek', { time: 12 })).status, 404, 'a good time for a session that is gone');
});

test('optIndex and hlsSeekTime: the play and seek body checks', () => {
  const bad = (fn: () => unknown) => assert.throws(fn, (e: unknown) => (e as { status?: number }).status === 400);
  const idx: [unknown, number | undefined][] = [[undefined, undefined], [null, undefined], [0, 0], [3, 3]];
  for (const [v, want] of idx) assert.equal(playRoutes.optIndex(v, 'fileIdx'), want, String(v));
  for (const v of [-1, 1.5, NaN, Infinity, '1', true, {}, []]) bad(() => playRoutes.optIndex(v, 'fileIdx'));
  const M = playRoutes.SEEK_END_MARGIN_S;
  const seeks: [unknown, number | undefined, number][] = [
    [0, undefined, 0], [42.5, undefined, 42.5], [-3, undefined, 0], [1e6, undefined, 1e6],
    [600, 3600, 600], [3600, 3600, 3600 - M], [99_999, 3600, 3600 - M], [2, 3, 0],
    [600, 0, 600], [600, NaN, 600], [600, Infinity, 600],   // a duration the probe did not find: no clamp
  ];
  for (const [v, dur, want] of seeks) assert.equal(playRoutes.hlsSeekTime(v, dur), want, `${v} of ${dur}`);
  for (const v of [NaN, Infinity, -Infinity, '12', null, undefined, {}]) bad(() => playRoutes.hlsSeekTime(v, 3600));
});

/** A local stream addon for movies and series: answers every stream request with `streams` and notes the paths asked. */
async function streamAddon(streams: object[]): Promise<{ url: string; asked: string[]; close: () => void }> {
  const asked: string[] = [];
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/manifest.json')) { res.end(JSON.stringify({ id: 'local.streams', name: 'Local streams', resources: ['stream'], types: ['movie', 'series'] })); return; }
    asked.push(req.url || ''); res.end(JSON.stringify({ streams }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/cfg/manifest.json`, asked, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('streams: ranked on live tracker seeders, the running time and the kind asked for; a film called Open Season 2 is no season pack', async () => {
  const H = { film: 'a1'.repeat(20), web: 'b2'.repeat(20), dead: 'e5'.repeat(20) };
  const info = (seeds: number, provider: string) => `👤 ${seeds} 💾 1.5 GB ⚙️ ${provider}`;
  const addon = await streamAddon([
    { name: 'Local\n1080p', title: `Open.Season.2.2008.1080p.BluRay.x264-AAA\n${info(7, 'ProviderA')}`, infoHash: H.film.toUpperCase() },
    { name: 'Local\n1080p', title: `Open.Season.2.2008.1080p.WEBRip.x264-BBB\n${info(60, 'ProviderB')}`, infoHash: H.web, fileIdx: 0 },
    { name: 'Local\n1080p', title: `Open.Season.2.2008.1080p.BluRay.x264-CCC\n${info(5000, 'ProviderC')}`, infoHash: H.dead },
  ]);
  const addons = store.getState().settings.addons;
  store.update((s) => { s.settings.addons = [addon.url]; });
  trackerSeeds.set(H.film, 40); trackerSeeds.set(H.dead, 0);   // nobody answers for H.web: the addon's 60 stands
  // Cinemeta answers from here: the running time the pick works with. No test reaches the real one.
  const real = globalThis.fetch; const metaAsked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return real(input, init);
    metaAsked.push(url);
    return new Response(JSON.stringify({ meta: { id: 'tt0000077', name: 'Open Season 2', runtime: '86 min' } }));
  }) as typeof fetch;
  type S = { id: string; infoHash: string; seeders?: number; seedersLive?: boolean; headroom?: number; warnings: string[] };
  const get = async (p: string) => { const r = await call('GET', p); assert.equal(r.status, 200, p); return { auto: r.body?.auto, pickKey: r.body?.pickKey as string, list: r.body?.sources as S[], by: (h: string) => (r.body?.sources as S[]).find((s) => s.infoHash === h)! }; };
  try {
    const movie = await get('/streams/movie/tt0000077');
    assert.deepEqual(scraped, [[H.film, H.web, H.dead]], 'one batch, lowercase hashes');
    assert.deepEqual(movie.list.map((s) => s.infoHash), [H.film, H.web, H.dead], 'the film ranks first on its live 40 seeders');
    assert.deepEqual([movie.by(H.film).seeders, movie.by(H.film).seedersLive], [40, true]);
    assert.deepEqual([movie.by(H.web).seeders, movie.by(H.web).seedersLive], [60, undefined]);
    assert.ok(metaAsked.some((u) => u.includes('/meta/movie/tt0000077')), 'the running time comes from the title');
    assert.ok(movie.by(H.film).headroom! > movie.by(H.web).headroom!, 'a live count weighs more than the addon\'s');
    assert.equal(movie.by(H.dead).headroom, 0);
    assert.deepEqual([movie.by(H.dead).seeders, movie.by(H.dead).seedersLive], [0, true], 'the addon said 5000, the trackers say 0');
    assert.ok(movie.by(H.dead).warnings.includes('No seeders reported'));
    assert.ok(!movie.list.some((s) => s.warnings.includes('Season pack without file index')), 'asked as a movie: no season packs');
    assert.equal(movie.auto, movie.by(H.film).id);

    const episode = await get('/streams/series/tt0000077:2:1');
    assert.deepEqual(episode.list.map((s) => s.infoHash), [H.web, H.film, H.dead], 'asked as a series: the release without a file index drops');
    assert.ok(episode.by(H.film).warnings.includes('Season pack without file index'));
    assert.ok(!episode.by(H.web).warnings.includes('Season pack without file index'), 'a file index points at one episode');
    assert.equal(episode.auto, episode.by(H.web).id);
    assert.equal(scraped.length, 1, 'the counts are cached: the trackers are not asked again');
    assert.deepEqual(addon.asked, ['/cfg/stream/movie/tt0000077.json', '/cfg/stream/series/tt0000077%3A2%3A1.json'], 'the addon is asked for the kind in the path');

    // A release played from the list: one line in the local pick log, features only.
    const { PICKS_FILE } = await import('../server/picks.ts');
    assert.match(movie.pickKey, /^[0-9a-f]{12}$/);
    assert.equal((await call('POST', '/picks', { key: movie.pickKey, chosen: movie.by(H.web).id, via: 'cast' })).status, 204);
    const lines = fs.readFileSync(PICKS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0], t: 0, sources: lines[0].sources.length }, { t: 0, v: 2, videoId: 'tt0000077', type: 'movie', target: 'browser', via: 'cast', runtimeSec: 86 * 60, auto: movie.auto, chosen: movie.by(H.web).id, sources: 3 });
    assert.ok(lines[0].sources.every((s: Record<string, unknown>) => !('score' in s) && !('warnings' in s) && !('addon' in s)));
    assert.equal((await call('POST', '/picks', { key: 'ffffffffffff', chosen: movie.by(H.web).id })).status, 204, 'a list Kino no longer remembers: nothing to log');
    for (const bad of [{}, { key: movie.pickKey }, { key: 'nope', chosen: movie.by(H.web).id }, { key: movie.pickKey, chosen: 'not a source' }])
      assert.equal((await call('POST', '/picks', bad)).status, 400, JSON.stringify(bad));
    assert.equal(fs.readFileSync(PICKS_FILE, 'utf8').trim().split('\n').length, 1);

    // What became of it in the player: an outcome line tied to that pick. A release no pick names logs nothing.
    const stall = { videoId: 'tt0000077', chosen: movie.by(H.web).id, outcome: 'stall', pos: 600.4, watchedSec: 42 };
    assert.equal((await call('POST', '/picks/outcome', stall)).status, 204);
    assert.equal((await call('POST', '/picks/outcome', { ...stall, chosen: movie.by(H.film).id })).status, 204, 'not the release picked: nothing to log');
    for (const bad of [{}, { ...stall, outcome: 'boom' }, { ...stall, chosen: 'not a source' }, { ...stall, videoId: '' }, { ...stall, videoId: 7 }])
      assert.equal((await call('POST', '/picks/outcome', bad)).status, 400, JSON.stringify(bad));
    const all = fs.readFileSync(PICKS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(all.length, 2);
    assert.deepEqual({ ...all[1], t: 0 }, { t: 0, outcome: 'stall', videoId: 'tt0000077', chosen: movie.by(H.web).id, pickT: all[0].t, pos: 600, watchedSec: 42 });
  } finally {
    globalThis.fetch = real;
    store.update((s) => { s.settings.addons = addons; });
    addon.close();
  }
});

test('decodeCaps: ?hevc=1 and ?av1=1, anything else names nothing', () => {
  assert.deepEqual(util.decodeCaps({ hevc: '1', av1: '1' }), { hevc: true, av1: true });
  assert.deepEqual(util.decodeCaps({ hevc: '1', av1: '0' }), { hevc: true });
  assert.deepEqual(util.decodeCaps({ av1: '1', target: 'browser' }), { av1: true });
  for (const q of [{}, { hevc: 'true' }, { hevc: ['1', '1'] }, { av1: 1 }, { hevc: '' }]) assert.equal(util.decodeCaps(q), undefined, JSON.stringify(q));
});

test('streams: a browser that says it decodes HEVC is charged no transcode for it; a TV is, whatever it says', async () => {
  const H = { avc: 'c1'.repeat(20), hevc: 'd2'.repeat(20) };
  const addon = await streamAddon([
    { name: 'Local\n1080p', title: `Film.2009.1080p.WEB-DL.H264-AAA\n👤 300 💾 2 GB ⚙️ ProviderA`, infoHash: H.avc, fileIdx: 0 },
    { name: 'Local\n1080p', title: `Film.2009.1080p.WEB-DL.H265-BBB\n👤 300 💾 2 GB ⚙️ ProviderB`, infoHash: H.hevc, fileIdx: 0 },
  ]);
  const addons = store.getState().settings.addons;
  store.update((s) => { s.settings.addons = [addon.url]; });
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith('http://127.0.0.1') ? real(input, init) : new Response(JSON.stringify({ meta: { id: 'tt0000078', name: 'Film', runtime: '100 min' } }));
  }) as typeof fetch;
  type S = { infoHash: string; score: number; warnings: string[] };
  const get = async (q: string) => {
    const r = await call('GET', `/streams/movie/tt0000078${q}`); assert.equal(r.status, 200, q);
    const list = r.body?.sources as S[];
    return { auto: list.find((s) => `${s.infoHash}:0` === r.body?.auto)?.infoHash, hevc: list.find((s) => s.infoHash === H.hevc)!, pickKey: r.body?.pickKey as string };
  };
  try {
    const plain = await get('?target=browser');
    assert.equal(plain.auto, H.avc);
    assert.ok(plain.hevc.warnings.includes('HEVC: transcodes in browser'));
    const decodes = await get('?target=browser&hevc=1&av1=1');
    assert.equal(decodes.auto, H.hevc, 'decoded as is: the leaner codec wins on its bits');
    assert.deepEqual(decodes.hevc.warnings, []);
    assert.equal(decodes.hevc.score, plain.hevc.score + 6);
    assert.deepEqual((await get('?hevc=1')).hevc.warnings, [], 'no target is the browser');
    for (const tv of ['chromecast', 'ios']) {
      const asked = await get(`?target=${tv}&hevc=1`), bare = await get(`?target=${tv}`);
      assert.deepEqual([asked.hevc.score, asked.hevc.warnings], [bare.hevc.score, bare.hevc.warnings], tv);
      assert.ok(asked.hevc.warnings.some((w) => /transcode/.test(w)), tv);
    }
    // The pick log keeps what the browser said, so the pick can be judged again as it was made.
    const { PICKS_FILE } = await import('../server/picks.ts');
    assert.equal((await call('POST', '/picks', { key: decodes.pickKey, chosen: `${H.hevc}:0`, via: 'play' })).status, 204);
    assert.deepEqual(JSON.parse(fs.readFileSync(PICKS_FILE, 'utf8').trim().split('\n').at(-1)!).caps, { hevc: true, av1: true });
  } finally {
    globalThis.fetch = real;
    store.update((s) => { s.settings.addons = addons; });
    addon.close();
  }
});

/**
 * Every method and path the API serves, with the part that serves it. A param's name does not matter: `/x/:id` and `/x/:key` are one path.
 * `sample` is a request the route serves, params filled in; `matches` is Express's own test of a request path against the route.
 */
type Layer = { slash?: boolean; handle: { stack?: Layer[] }; route?: { path: string; methods: Record<string, boolean> }; match: (p: string) => boolean };
type Served = { method: string; path: string; part: string; sample: string; matches: (p: string) => boolean };
function served(router: unknown, part: (r: unknown) => string): Served[] {
  const out: Served[] = [];
  const walk = (stack: Layer[], where: string) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ method: m === '_all' ? '*' : m.toUpperCase(), path: l.route.path.replace(/[:*][A-Za-z_$][\w$]*/g, (x) => x[0]), part: where, sample: l.route.path.replace(/[:*][A-Za-z_$][\w$]*/g, '~p').replace(/[{}]/g, ''), matches: (p) => l.match(p) });
      else if (l.handle.stack) {
        assert.ok(l.slash, 'a part mounted under a prefix: teach this walk the prefix');
        walk(l.handle.stack, part(l.handle));
      }
    }
  };
  walk((router as { stack: Layer[] }).stack, part(router));
  return out;
}
const sameMethod = (a: Served, b: Served) => a.method === b.method || a.method === '*' || b.method === '*';
/** Pairs of entries that answer one request: the same path and method, or the same path and an all-methods route. */
function clashes(list: Served[]): string[] {
  const out: string[] = [];
  list.forEach((a, i) => { for (const b of list.slice(i + 1)) if (a.path === b.path && sameMethod(a, b)) out.push(`${a.method} ${a.path} (${a.part}) and ${b.method} ${b.path} (${b.part})`); });
  return out;
}
/** Routes an earlier one answers first (Express takes the first match): `GET /x/:id` before `GET /x/new` leaves the second dead. */
function shadows(list: Served[]): string[] {
  const out: string[] = [];
  list.forEach((a, i) => { for (const b of list.slice(i + 1)) if (a.path !== b.path && sameMethod(a, b) && a.matches(b.sample)) out.push(`${b.method} ${b.path} (${b.part}) behind ${a.method} ${a.path} (${a.part})`); });
  return out;
}

test('no method and path is served twice or behind an earlier route, by two parts or by one', async () => {
  const names = new Map<unknown, string>([[api, 'index']]);
  for (const n of ['browse', 'library', 'play', 'subs', 'cast', 'settings']) names.set((await import(`../server/routes/${n}.ts`)).api, n);
  const list = served(api, (r) => names.get(r) ?? 'an unnamed part');
  assert.ok(list.length > 50, `the walk sees the API (${list.length} routes)`);
  assert.ok(list.some((r) => r.method === 'GET' && r.path === '/streams/:/:' && r.part === 'browse'));
  assert.ok(list.some((r) => r.method === '*' && r.path === '/file/:/:' && r.part === 'play'));
  assert.deepEqual(clashes(list), []);
  assert.deepEqual(shadows(list), []);

  // The check itself: a second part with a renamed param, and a GET under an all-methods route, are both caught.
  const { apiRouter } = await import('../server/routes/util.ts');
  const a = apiRouter(); const b = apiRouter(); const top = apiRouter();
  a.get('/watchlist/:id', () => undefined); a.all('/file/:h', () => undefined);
  b.get('/watchlist/:metaId', () => undefined); b.put('/watchlist/:id', () => undefined); b.get('/file/:hash', () => undefined);
  top.use(a, b);
  const fake = new Map<unknown, string>([[top, 'top'], [a, 'a'], [b, 'b']]);
  assert.deepEqual(clashes(served(top, (r) => fake.get(r)!)), ['GET /watchlist/: (a) and GET /watchlist/: (b)', '* /file/: (a) and GET /file/: (b)']);

  // And a param route that answers a fixed path first, for its method, in a later part or later in its own. A longer path, another method or another suffix is no shadow.
  const c = apiRouter(); const d = apiRouter(); const both = apiRouter();
  c.get('/x/:id', () => undefined); c.all('/f/:h', () => undefined); c.get('/y/:id/z', () => undefined); c.get('/s/:id.vtt', () => undefined);
  d.get('/x/new', () => undefined); d.post('/x/new', () => undefined); d.get('/f/new', () => undefined); d.get('/y/new', () => undefined); d.get('/x/new/more', () => undefined);
  d.get('/s/one.srt', () => undefined); d.get('/s/one.vtt', () => undefined); d.get('/z/:id', () => undefined); d.get('/z/top', () => undefined);
  both.use(c, d);
  const fake2 = new Map<unknown, string>([[both, 'both'], [c, 'c'], [d, 'd']]);
  assert.deepEqual(shadows(served(both, (r) => fake2.get(r)!)), ['GET /x/new (d) behind GET /x/: (c)', 'GET /f/new (d) behind * /f/: (c)', 'GET /s/one.vtt (d) behind GET /s/:.vtt (c)', 'GET /z/top (d) behind GET /z/: (d)']);
});

test('recovered/dismiss: Settings says the state file started fresh once, then /health stops saying so', async () => {
  store.flushSync();
  const file = path.join(DIR, 'damaged.json');
  fs.writeFileSync(file, '{"progress":');
  const w = process.stderr.write; process.stderr.write = (() => true) as typeof w;   // the store logs the fresh start as an error
  try { store.load(file); } finally { process.stderr.write = w; }
  try {
    assert.ok(store.recoveryNotice()?.movedTo, 'a load that started fresh says so');
    assert.deepEqual(await call('POST', '/recovered/dismiss'), { status: 200, body: { ok: true } });
    assert.equal(store.recoveryNotice(), undefined);
    assert.equal(store.recoveredFromCorrupt(), undefined);
    assert.deepEqual(await call('POST', '/recovered/dismiss'), { status: 200, body: { ok: true } }, 'twice is fine');
    assert.equal((await call('GET', '/recovered/dismiss')).status, 404, 'a write only');
  } finally {
    store.load(path.join(DIR, 'state.json'));   // the rest of this file runs on the state it started with
  }
});

test('recovered/dismiss: the repair and prune counts /health says once go too', async () => {
  store.flushSync();
  const file = path.join(DIR, 'repairable.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, settings: { onboarded: true }, watchlist: null, castHistory: { 'old-tv': [{ ts: 1, app: 'Kino', title: 'A' }] } }));
  try {
    store.load(file);
    assert.deepEqual({ ...store.repairNotice(), at: 0 }, { repairedFields: 1, droppedProgress: 0, prunedProgress: 0, prunedCastDevices: 1, backup: `${file}.bak`, at: 0 });
    assert.deepEqual(await call('POST', '/recovered/dismiss'), { status: 200, body: { ok: true } });
    assert.equal(store.repairNotice(), undefined);
    assert.ok(fs.existsSync(`${file}.bak`), 'the copy stays: only the notice goes');
  } finally {
    store.load(path.join(DIR, 'state.json'));
  }
});

test('cache/clear: clearing all keeps downloads saved for later, finished or not; /disk counts their bytes apart', async () => {
  const { CACHE_DIR } = await import('../server/config.ts');
  const done = '1'.repeat(40), going = '2'.repeat(40), plain = '3'.repeat(40);
  const dl = (h: string, finished: boolean) => ({ key: `${h}:0`, infoHash: h, fileIdx: 0, type: 'movie' as const, name: h, sizeBytes: 50, addedAt: 1, done: finished, ...(finished ? { doneAt: 2 } : {}) });
  for (const [h, bytes] of [[done, 50], [going, 20], [plain, 30]] as const) {
    fs.mkdirSync(path.join(CACHE_DIR, h), { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, h, 'f.mkv'), 'x');
    store.update((s) => { s.cacheIndex[h] = { infoHash: h, name: h, bytes, lastUsed: 1 }; });
  }
  store.update((s) => { s.downloads[`${done}:0`] = dl(done, true); s.downloads[`${going}:0`] = dl(going, false); });
  try {
    const disk = (await call('GET', '/disk')).body!;
    assert.equal(disk.downloadBytes, 70, 'both downloads, not the plain entry');
    const flags = Object.fromEntries((disk.entries as { infoHash: string; download: boolean }[]).map((e) => [e.infoHash, e.download]));
    assert.deepEqual([flags[done], flags[going], flags[plain]], [true, true, false]);

    const r = await call('POST', '/cache/clear', {});
    assert.equal(r.status, 200);
    const left = (r.body!.entries as { infoHash: string }[]).map((e) => e.infoHash);
    assert.ok(left.includes(done) && left.includes(going), 'downloads stay in the answer');
    assert.ok(!left.includes(plain));
    assert.equal(r.body!.downloadBytes, 70);
    assert.ok(store.getState().cacheIndex[done] && store.getState().cacheIndex[going], 'and in the index');
    assert.equal(store.getState().cacheIndex[plain], undefined);
    assert.ok(fs.existsSync(path.join(CACHE_DIR, done, 'f.mkv')), 'the finished file is still on disk');
    assert.ok(!fs.existsSync(path.join(CACHE_DIR, plain)));

    // One entry asked for by name goes, download or not.
    assert.equal((await call('POST', '/cache/clear', { infoHash: done })).status, 200);
    assert.equal(store.getState().cacheIndex[done], undefined);
  } finally {
    store.update((s) => { delete s.downloads[`${done}:0`]; delete s.downloads[`${going}:0`]; });
    for (const h of [done, going, plain]) await torrent.remove(h);
  }
});

test('cache/clear: deleting one download row also takes it off the downloads list, every file of that torrent', async () => {
  const { CACHE_DIR } = await import('../server/config.ts');
  const pack = '4'.repeat(40), other = '5'.repeat(40);
  const dl = (h: string, idx: number) => ({ key: `${h}:${idx}`, infoHash: h, fileIdx: idx, type: 'series' as const, name: `${h}:${idx}`, sizeBytes: 50, addedAt: 1, done: true, doneAt: 2 });
  for (const h of [pack, other]) {
    fs.mkdirSync(path.join(CACHE_DIR, h), { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, h, 'f.mkv'), 'x');
    store.update((s) => { s.cacheIndex[h] = { infoHash: h, name: h, bytes: 100, lastUsed: 1 }; });
  }
  store.update((s) => { for (const d of [dl(pack, 0), dl(pack, 1), dl(other, 0)]) s.downloads[d.key] = d; });
  try {
    const r = await call('POST', '/cache/clear', { infoHash: pack });
    assert.equal(r.status, 200);
    assert.equal(store.getState().cacheIndex[pack], undefined);
    assert.ok(!fs.existsSync(path.join(CACHE_DIR, pack)), 'its files are gone');
    assert.deepEqual(Object.keys(store.getState().downloads).sort(), [`${other}:0`], 'both episodes of the pack leave the list, the other download stays');
    const listed = (await fetch(`${base}/downloads`).then((x) => x.json()) as { key: string }[]).map((d) => d.key);
    assert.deepEqual(listed, [`${other}:0`], 'Library no longer offers a finished download whose file is gone');
    assert.equal(r.body!.downloadBytes, 100, 'only the download left counts as saved for later');
  } finally {
    store.update((s) => { for (const k of [`${pack}:0`, `${pack}:1`, `${other}:0`]) delete s.downloads[k]; });
    for (const h of [pack, other]) await torrent.remove(h);
  }
});
