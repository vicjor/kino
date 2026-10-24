import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const { getStreams, getAddonSubtitles, subtitleTimeout, streamTimeout, unanswered, listAddons, skippedAddons, addonKey } = await import('../server/addons.ts');
const { getState } = await import('../server/store.ts');
const { NO_ANSWER, REFUSED } = await import('../server/net-guard.ts');

/** How a local addon answers streams or subtitles: `hang` takes the request and never answers. */
type Reply = { delayMs?: number; status?: number; body?: object } | 'hang';
/** A local addon serving `resource` for movies. Counts the requests that are not for the manifest. */
async function addon(name: string, resource: 'stream' | 'subtitles', reply: Reply): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    const json = (status: number, body: object) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url?.endsWith('/manifest.json')) return json(200, { id: name.toLowerCase(), name, resources: [resource], types: ['movie'] });
    hits++;
    if (reply === 'hang') return;
    setTimeout(() => json(reply.status ?? 200, reply.body ?? {}), reply.delayMs ?? 0);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/cfg/manifest.json`, hits: () => hits };
}
const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(DIR, { recursive: true, force: true }); });

/** Run fn with stderr muted (the failures below are logged as warnings). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const w = process.stderr.write;
  process.stderr.write = (() => true) as typeof w;
  try { return await fn(); } finally { process.stderr.write = w; }
}
const sub = (id: string) => ({ id, url: `https://subs.example.org/${id}.srt`, lang: 'eng' });

test('subtitles: answers are cached per addon and request, a silent addon is skipped for that request only', async () => {
  subtitleTimeout.ms = 150;
  const slow = await addon('ProviderB', 'subtitles', 'hang');
  const fast = await addon('ProviderA', 'subtitles', { body: { subtitles: [sub('a1')] } });
  getState().settings.addons = [slow.url, fast.url];

  let t0 = Date.now();
  const first = await quiet(() => getAddonSubtitles('movie', 'tt1', { filename: 'Movie.mkv' }));
  const cold = Date.now() - t0;
  assert.deepEqual(first, [{ addon: 'ProviderB', subs: [], lan: false }, { addon: 'ProviderA', subs: [sub('a1')], lan: true }]);
  assert.ok(cold >= 120, `the hanging addon cost its timeout once (took ${cold} ms)`);
  assert.deepEqual([slow.hits(), fast.hits()], [1, 1]);

  t0 = Date.now();
  const again = await getAddonSubtitles('movie', 'tt1', { filename: 'Movie.mkv' });
  assert.deepEqual(again, first);
  assert.deepEqual([slow.hits(), fast.hits()], [1, 1], 'same request: served from the cache');

  const other = await quiet(() => getAddonSubtitles('movie', 'tt2', {}));
  assert.deepEqual(other.map((a) => a.addon), ['ProviderB', 'ProviderA']);
  assert.deepEqual([slow.hits(), fast.hits()], [2, 2], 'another request asks every addon again: one slow answer must not hide the rest');
  assert.ok(Date.now() - t0 >= 120, 'so it pays the timeout again');

  await getAddonSubtitles('movie', 'tt1', { filename: 'Movie.mkv', videoHash: 'abc', videoSize: 1 });
  assert.equal(fast.hits(), 3, 'a hashed request is its own cache entry');
});

test('subtitles: an addon that answers with an error is asked again, not skipped for a minute', async () => {
  const erring = await addon('ProviderE', 'subtitles', { status: 500 });
  const missing = await addon('ProviderF', 'subtitles', { status: 404 });
  getState().settings.addons = [erring.url, missing.url];
  const first = await quiet(() => getAddonSubtitles('movie', 'tt30', {}));
  assert.deepEqual(first, [{ addon: 'ProviderE', subs: [], lan: false }, { addon: 'ProviderF', subs: [], lan: false }]);
  assert.deepEqual([erring.hits(), missing.hits()], [1, 1]);
  await quiet(() => getAddonSubtitles('movie', 'tt31', {}));
  assert.deepEqual([erring.hits(), missing.hits()], [2, 2], 'another video asks both again');
  await quiet(() => getAddonSubtitles('movie', 'tt30', {}));
  assert.deepEqual([erring.hits(), missing.hits()], [3, 3], 'an error is not cached as an answer either');
});

test('subtitles: concurrent identical requests share one fetch, an odd body counts as none', async () => {
  const odd = await addon('ProviderC', 'subtitles', { delayMs: 30, body: { subtitles: 'nope' } });
  getState().settings.addons = [odd.url];
  const [a, b] = await Promise.all([getAddonSubtitles('movie', 'tt3', {}), getAddonSubtitles('movie', 'tt3', {})]);
  assert.deepEqual(a, [{ addon: 'ProviderC', subs: [], lan: false }]);
  assert.deepEqual(b, a);
  assert.equal(odd.hits(), 1);
});

test('getStreams lists queried and failed addons in settings order, not answer order', async () => {
  const late = await addon('ProviderA', 'stream', { delayMs: 120, status: 500 });
  const early = await addon('ProviderB', 'stream', { status: 500 });
  const ok = await addon('ProviderC', 'stream', { delayMs: 60, body: { streams: [{ name: 'C\n1080p', title: 'Movie.2025.1080p.WEB-DL.x264-GRP\n👤 5 💾 2 GB ⚙️ ProviderX', infoHash: 'a'.repeat(40) }] } });
  getState().settings.addons = [late.url, ok.url, early.url];
  const r = await quiet(() => getStreams('movie', 'tt9'));
  assert.deepEqual(r.queried, ['ProviderA', 'ProviderC', 'ProviderB']);
  assert.deepEqual(r.failed, ['ProviderA', 'ProviderB']);
  assert.equal(r.sources.length, 1);
});

const stream = (hash: string) => ({ name: 'A\n1080p', title: `Movie.2025.1080p.WEB-DL.x264-GRP\n👤 5 💾 2 GB`, infoHash: hash.repeat(40) });

test('streams: an addon that never answers is skipped for a minute, one that answers with an error is asked again', async () => {
  streamTimeout.ms = 150;
  const dead = await addon('ProviderB', 'stream', 'hang');
  const erring = await addon('ProviderD', 'stream', { status: 500 });
  const ok = await addon('ProviderA', 'stream', { body: { streams: [stream('b')] } });
  getState().settings.addons = [dead.url, erring.url, ok.url];

  let t0 = Date.now();
  const first = await quiet(() => getStreams('movie', 'tt20'));
  const cold = Date.now() - t0;
  assert.deepEqual(first.failed, ['ProviderB', 'ProviderD']);
  assert.equal(first.sources.length, 1);
  assert.ok(cold >= 120, `the silent addon cost its timeout once (took ${cold} ms)`);
  assert.deepEqual([dead.hits(), erring.hits(), ok.hits()], [1, 1, 1]);

  t0 = Date.now();
  const other = await quiet(() => getStreams('movie', 'tt21'));
  const warm = Date.now() - t0;
  assert.deepEqual(other.queried, ['ProviderB', 'ProviderD', 'ProviderA']);
  assert.deepEqual(other.failed, ['ProviderB', 'ProviderD'], 'the skipped addon still shows as not reached');
  assert.deepEqual([dead.hits(), erring.hits(), ok.hits()], [1, 2, 2], 'the silent addon is not asked, the erring one is');
  assert.ok(warm < 120, `no timeout paid within the minute (took ${warm} ms)`);

  await quiet(() => getStreams('movie', 'tt20'));
  assert.equal(ok.hits(), 2, 'same video: served from the cache');
});

test('unanswered: timeouts and unreachable hosts, never an HTTP error or an odd body', () => {
  assert.equal(unanswered(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
  assert.equal(unanswered(new TypeError('fetch failed')), true);
  assert.equal(unanswered(new Error('500 Internal Server Error for http://127.0.0.1:1')), false);
  assert.equal(unanswered(new SyntaxError('Unexpected token')), false);
  assert.equal(unanswered(new TypeError('r.streams.map is not a function')), false);
  assert.equal(unanswered('fetch failed'), false);
  assert.equal(unanswered(Object.assign(new Error('The addon did not answer in time'), { status: 502, code: NO_ANSWER })), true, 'net-guard: no answer');
  assert.equal(unanswered(Object.assign(new Error('That addon points at a private network address'), { status: 403, code: REFUSED })), false, 'a refusal is quick, not silence');
});

test('listAddons: an addon skipped for not answering says when and why, for a minute; one that answered with an error does not', async () => {
  streamTimeout.ms = 300; subtitleTimeout.ms = 300;
  const dead = await addon('ProviderB', 'stream', 'hang');
  const erring = await addon('ProviderD', 'stream', { status: 500 });
  const silentSubs = await addon('ProviderS', 'subtitles', 'hang');
  const urls = [dead.url, erring.url, silentSubs.url];
  getState().settings.addons = urls;
  assert.deepEqual((await listAddons()).map((r) => r.skipped), [undefined, undefined, undefined], 'nothing failed yet');

  const t0 = Date.now();
  await quiet(() => getStreams('movie', 'tt40'));
  await quiet(() => getAddonSubtitles('movie', 'tt40', {}));
  const rows = await listAddons();
  assert.deepEqual(rows.map((r) => [r.ok, !!r.skipped]), [[true, true], [true, false], [true, true]]);
  for (const r of [rows[0], rows[2]]) {
    assert.ok(r.skipped!.failedAt >= t0 && r.skipped!.failedAt <= Date.now(), 'when it failed');
    assert.match(r.skipped!.reason, /timeout|did not answer in time/i);
    assert.ok(!JSON.stringify(r.skipped).includes('/cfg'), 'no addon URL in the failure');
  }
  assert.deepEqual(Object.keys(skippedAddons(urls)), [addonKey(dead.url), addonKey(silentSubs.url)], 'keyed by addon key, never by URL');

  skippedAddons(urls)[addonKey(dead.url)].failedAt = 0; rows[0].skipped!.reason = 'changed';
  const again = skippedAddons(urls)[addonKey(dead.url)];
  assert.ok(again.failedAt >= t0, 'read only: what callers change stays with them');
  assert.match(again.reason, /timeout|did not answer in time/i);

  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try { assert.deepEqual(skippedAddons(urls), {}, 'a minute later nothing is skipped'); } finally { Date.now = realNow; }
});
