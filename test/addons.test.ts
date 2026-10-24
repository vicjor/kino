import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const { addonsFor, addAddon, manifestTimeout } = await import('../server/addons.ts');
const { getState } = await import('../server/store.ts');

/** A local addon. `delayMs` null means it takes the request and never answers. */
async function addon(manifest: object | null, delayMs: number | null = 0): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    if (delayMs == null) return;
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); }, delayMs);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  servers.push(srv);
  return { url: `http://127.0.0.1:${port}/manifest.json`, hits: () => hits };
}
const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(DIR, { recursive: true, force: true }); });

test('addonsFor loads manifests in parallel, keeps settings order, and remembers a failure for a minute', async () => {
  manifestTimeout.ms = 150;
  const hang = await Promise.all([addon(null, null), addon(null, null), addon(null, null)]);
  const slow = await addon({ id: 'b', name: 'ProviderB', resources: [{ name: 'subtitles', types: ['movie'] }], types: ['movie', 'series'] }, 50);
  const fast = await addon({ id: 'a', name: 'ProviderA', resources: ['stream', 'subtitles'], types: ['movie'] });
  getState().settings.addons = [hang[0].url, slow.url, hang[1].url, fast.url, hang[2].url];

  let t0 = Date.now();
  const subs = await addonsFor('subtitles', 'movie');
  const cold = Date.now() - t0;
  assert.deepEqual(subs.map((a) => a.m.name), ['ProviderB', 'ProviderA']);   // settings order, not arrival order
  assert.ok(cold >= 120 && cold < 400, `three hanging addons cost one timeout, not three (took ${cold} ms)`);
  for (const h of hang) assert.equal(h.hits(), 1);

  t0 = Date.now();
  assert.deepEqual((await addonsFor('stream', 'movie')).map((a) => a.m.name), ['ProviderA']);
  const warm = Date.now() - t0;
  assert.ok(warm < 100, `a failure within the minute is not asked again (took ${warm} ms)`);
  for (const h of [...hang, slow, fast]) assert.equal(h.hits(), 1);
});

test('addAddon: a bad address is a 400, an addon that does not answer a 502 naming its origin, one with nothing to play a 422', async () => {
  manifestTimeout.ms = 150;
  const statusIs = (status: number, re: RegExp) => (e: unknown) => (e as { status?: number }).status === status && re.test((e as Error).message);
  for (const u of ['', 'ftp://x.test/manifest.json', 'https://x.test/addon']) await assert.rejects(addAddon(u), statusIs(400, /starts with http or https and points to its manifest\.json/), u);
  const quietly = <T>(p: Promise<T>) => { const w = process.stderr.write; process.stderr.write = (() => true) as typeof w; return p.finally(() => { process.stderr.write = w; }); };
  const silent = await addon(null, null);
  await assert.rejects(quietly(addAddon(silent.url)), statusIs(502, /^Kino could not load that addon \(The addon did not answer in time\)$/));
  const gone = http.createServer((_req, res) => { res.statusCode = 404; res.end('<pre>Cannot GET</pre>'); });
  await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r)); servers.push(gone);
  const origin = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
  await assert.rejects(quietly(addAddon(`${origin}/secret-token/manifest.json`)), (e: unknown) => statusIs(502, /^Kino could not load that addon \(404 /)(e) && (e as Error).message.includes(origin) && !(e as Error).message.includes('secret-token'));
  const clock = await addon({ id: 'clock', name: 'Clock', resources: ['catalog'], types: ['other'] });
  await assert.rejects(addAddon(clock.url), statusIs(422, /^Addon "Clock" serves other Kino can play/));
  assert.equal(getState().settings.addons.includes(clock.url), false, 'nothing is saved');
});

test('concurrent requests share one manifest fetch', async () => {
  const a = await addon({ id: 'c', name: 'ProviderC', resources: ['stream'], types: ['series'] }, 50);
  getState().settings.addons = [a.url];
  const [x, y] = await Promise.all([addonsFor('stream', 'series'), addonsFor('stream', 'series')]);
  assert.equal(x.length, 1); assert.equal(y.length, 1);
  assert.equal(a.hits(), 1);
});
