import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const { encodeSubId, decodeSubId } = await import('../server/subs/ids.ts');
const { getVtt, listSubtitles } = await import('../server/subs/index.ts');
const { cachePath } = await import('../server/subs/cache.ts');
const { getState } = await import('../server/store.ts');
const guard = await import('../server/net-guard.ts');

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });
async function listen(handler: http.RequestListener, host = '127.0.0.1'): Promise<number> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, host, r));
  servers.push(srv);
  return (srv.address() as AddressInfo).port;
}

/** A subtitle host on the LAN, on [::1], that counts what reaches it. */
let lanHits = 0;
const LAN = await listen((_q, res) => { lanHits++; res.end(SRT); }, '::1');
/** Subtitle files on 127.0.0.1 (the internet or the LAN, per test): /a.srt, and /to?u=<url> redirecting there. */
const FILES = await listen((req, res) => {
  const to = new URL(req.url || '/', 'http://x').searchParams.get('u');
  if (to) { res.writeHead(302, { location: to }); res.end(); return; }
  if (req.url === '/a.srt') { res.end(SRT); return; }
  res.statusCode = 404; res.end();
});
/** A subtitle addon for movies whose list names `urls`. */
const addon = (urls: string[]) => listen((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url?.endsWith('/manifest.json') ? { id: 'subs', name: 'Subs', resources: ['subtitles'], types: ['movie'] } : { subtitles: urls.map((url, i) => ({ id: String(i), url, lang: 'eng' })) }));
});

/** Run fn with names answering from `dns`, and 127.0.0.1 counting as an internet address. */
async function asInternet(dns: Record<string, string[]>, fn: () => Promise<void>): Promise<void> {
  const { lookup, isPrivate } = guard.io;
  guard.io.lookup = async (h) => {
    const all = dns[h];
    if (!all) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND' });
    return all.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  guard.io.isPrivate = (ip) => ip !== '127.0.0.1' && guard.privateAddress(ip);
  try { await fn(); } finally { Object.assign(guard.io, { lookup, isPrivate }); }
}
const noTorrent = () => undefined;
const refused = { status: 403, message: 'That subtitle points at a private network address' };

test('a subtitle URL on the LAN from an internet addon is refused, nothing reaches it or is cached; from a LAN addon it plays', async () => {
  const n = lanHits;
  for (const u of [`http://[::1]:${LAN}/a.srt`, `http://127.0.0.1:${FILES}/a.srt`, 'http://192.168.1.1/a.srt', 'http://169.254.169.254/latest/meta-data']) {
    const id = encodeSubId({ o: 'os', u });
    await assert.rejects(getVtt(id, 0, noTorrent), refused, u);
    assert.equal(fs.existsSync(cachePath(id)), false, u);
  }
  assert.equal(lanHits, n, 'nothing reached the LAN host');
  assert.match(await getVtt(encodeSubId({ o: 'os', u: `http://[::1]:${LAN}/a.srt`, lan: 1 }), 0, noTorrent), /Hello/);
  assert.equal(lanHits, n + 1);
});

test('a redirect from a public subtitle host into the LAN is refused on every hop; one that stays public plays', async () => {
  await asInternet({ 'pub.test': ['127.0.0.1'], 'lan.test': ['::1'] }, async () => {
    const n = lanHits;
    const via = (to: string) => `http://pub.test:${FILES}/to?u=${encodeURIComponent(to)}`;
    for (const to of [`http://lan.test:${LAN}/a.srt`, `http://[::1]:${LAN}/a.srt`, 'http://10.0.0.1/a.srt', via(`http://[::1]:${LAN}/a.srt`)]) {
      await assert.rejects(getVtt(encodeSubId({ o: 'os', u: via(to) }), 0, noTorrent), refused, to);
    }
    assert.equal(lanHits, n, 'nothing reached the LAN host');
    assert.match(await getVtt(encodeSubId({ o: 'os', u: via(`http://pub.test:${FILES}/a.srt`) }), 0, noTorrent), /Hello/);
  });
});

test('listSubtitles: an id says whether its addon is on the LAN, so only a LAN addon can point Kino into the LAN', async () => {
  const lanFile = `http://[::1]:${LAN}/a.srt`;   // a fresh URL per id below: the disk cache would answer for one fetched before
  const home = await addon([`${lanFile}?from=home`]);
  getState().settings.addons = [`http://127.0.0.1:${home}/manifest.json`];
  const [mine] = await listSubtitles('movie', 'tt9001', undefined, undefined);
  assert.deepEqual(decodeSubId(mine.id), { o: 'os', u: `${lanFile}?from=home`, lan: 1 });
  const n = lanHits;
  assert.match(await getVtt(mine.id, 0, noTorrent), /Hello/);
  assert.equal(lanHits, n + 1);

  await asInternet({ 'pub.test': ['127.0.0.1'] }, async () => {
    const pub = await addon([`${lanFile}?from=internet`, `http://pub.test:${FILES}/a.srt`]);
    getState().settings.addons = [`http://pub.test:${pub}/manifest.json`];
    const tracks = await listSubtitles('movie', 'tt9002', undefined, undefined);
    assert.equal(tracks.length, 2);
    for (const t of tracks) assert.equal((decodeSubId(t.id) as { lan?: number }).lan, undefined, 'an internet addon: no lan mark');
    const [toLan, toPub] = [...tracks].sort((a, b) => String((decodeSubId(a.id) as { u: string }).u).localeCompare(String((decodeSubId(b.id) as { u: string }).u)));
    await assert.rejects(getVtt(toLan.id, 0, noTorrent), refused);
    assert.equal(lanHits, n + 1, 'nothing more reached the LAN host');
    assert.match(await getVtt(toPub.id, 0, noTorrent), /Hello/);
  });
});
