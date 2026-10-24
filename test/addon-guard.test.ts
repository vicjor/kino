import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
const { manifest, getStreams } = await import('../server/addons.ts');
const { getState } = await import('../server/store.ts');
const guard = await import('../server/net-guard.ts');

const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });
async function listen(srv: http.Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((r) => srv.listen(0, host, r));
  servers.push(srv);
  return (srv.address() as AddressInfo).port;
}

type Reply = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const STREAM = { name: 'A\n1080p', title: 'Movie.2025.1080p.WEB-DL.x264-GRP\n👤 5 💾 2 GB', infoHash: 'c'.repeat(40) };
const json = (body: object): Reply => (_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const redirect = (to: string): Reply => (_q, res) => { res.writeHead(302, { location: to }); res.end(); };

/** A box on the LAN, on [::1], that counts what reaches it. Redirects below point at it. */
let lanHits = 0;
const LAN_PORT = await listen(http.createServer((req, res) => { lanHits++; json({ streams: [STREAM] })(req, res); }), '::1');

/** A stream addon for movies: its manifest, then `streams` answers every other request. */
const addon = (name: string, streams: Reply) => listen(http.createServer((req, res) => {
  if (req.url?.endsWith('/manifest.json')) return json({ id: name, name, resources: ['stream'], types: ['movie'] })(req, res);
  streams(req, res);
}));

/** Run fn with names answering from `dns`, and 127.0.0.1 counting as an internet address when `loopbackIsInternet`. */
async function withNet(dns: Record<string, string[]>, loopbackIsInternet: boolean, fn: () => Promise<void>): Promise<void> {
  const { lookup, isPrivate } = guard.io;
  guard.io.lookup = async (h) => {
    const all = dns[h];
    if (!all) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND' });
    return all.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  if (loopbackIsInternet) guard.io.isPrivate = (ip) => ip !== '127.0.0.1' && guard.privateAddress(ip);
  try { await fn(); } finally { Object.assign(guard.io, { lookup, isPrivate }); }
}
/** Run fn with stderr muted (failing addons are logged as warnings). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const w = process.stderr.write;
  process.stderr.write = (() => true) as typeof w;
  try { return await fn(); } finally { process.stderr.write = w; }
}
const streamsFrom = async (url: string, id: string) => { getState().settings.addons = [url]; return quiet(() => getStreams('movie', id)); };

test('an addon the owner runs on the LAN works and may send Kino to the LAN: by address, or by a local name with a global IPv6 too', async () => {
  const port = await addon('Home', redirect(`http://[::1]:${LAN_PORT}/streams.json`));
  const n = lanHits;
  const r = await streamsFrom(`http://127.0.0.1:${port}/manifest.json`, 'tt100');
  assert.deepEqual(r.failed, []);
  assert.equal(r.sources.length, 1);
  assert.equal(lanHits, n + 1, 'the redirect into the LAN was followed');
  await withNet({ 'nas.local': ['127.0.0.1', '2606:4700:4700::1111'], 'mixed.test': ['127.0.0.1', '2606:4700:4700::1111'] }, false, async () => {
    const local = await streamsFrom(`http://nas.local:${port}/manifest.json`, 'tt101');
    assert.deepEqual([local.failed, local.sources.length], [[], 1], 'a .local name is the owner\'s LAN whatever else it resolves to');
    await quiet(() => assert.rejects(manifest(`http://mixed.test:${port}/manifest.json`, { retry: true }), { status: 403, message: 'That addon points at a private network address' }, 'the same answers under a public name'));
  });
});

test('an addon on the internet cannot reach the LAN: a redirect into it is refused on every hop, nothing arrives there', async () => {
  await withNet({ 'pub.test': ['127.0.0.1'], 'lan.test': ['::1'], 'two.test': ['127.0.0.1', '10.9.8.7'] }, true, async () => {
    const n = lanHits;
    for (const [i, to] of [`http://lan.test:${LAN_PORT}/s.json`, `http://[::1]:${LAN_PORT}/s.json`, 'http://10.0.0.1/s.json', 'http://169.254.169.254/latest/meta-data', 'file:///etc/hosts'].entries()) {
      const port = await addon(`Pub${i}`, redirect(to));
      const r = await streamsFrom(`http://pub.test:${port}/manifest.json`, `tt11${i}`);
      assert.deepEqual([r.failed, r.sources.length], [[`Pub${i}`], 0], to);
    }
    assert.equal(lanHits, n, 'nothing reached the LAN box');
    const two = await addon('Two', json({ streams: [STREAM] }));
    await quiet(() => assert.rejects(manifest(`http://two.test:${two}/manifest.json`, { retry: true }), { status: 403 }, 'one LAN address among a public name\'s answers'));
    const hop = await addon('Hop', (req, res) => (req.url?.includes('/stream/') ? redirect(`http://pub.test:${(req.socket.address() as AddressInfo).port}/final.json`) : json({ streams: [STREAM] }))(req, res));
    const ok = await streamsFrom(`http://pub.test:${hop}/manifest.json`, 'tt120');
    assert.deepEqual([ok.failed, ok.sources.length], [[], 1], 'a redirect that stays on the internet is followed');
  });
});

test(`addon redirects stop after ${guard.MAX_HOPS} hops`, async () => {
  let asked = 0;
  const port = await listen(http.createServer((req, res) => {
    asked++;
    const k = Number(req.url?.match(/^\/hop\/(\d+)\//)?.[1]);
    if (k > 0) return redirect(`/hop/${k - 1}/manifest.json`)(req, res);
    json({ id: 'h', name: 'Hops', resources: ['stream'], types: ['movie'] })(req, res);
  }));
  assert.equal((await manifest(`http://127.0.0.1:${port}/hop/${guard.MAX_HOPS}/manifest.json`, { retry: true })).name, 'Hops');
  asked = 0;
  await quiet(() => assert.rejects(manifest(`http://127.0.0.1:${port}/hop/50/manifest.json`, { retry: true }), { status: 502, message: 'The addon redirected too many times' }));
  assert.equal(asked, guard.MAX_HOPS + 1, 'stopped at the limit');
});
