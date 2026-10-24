import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const { encodeSubId, decodeSubId, secretKey, payloadOf, adoptSubId } = await import('../server/subs/ids.ts');
const { getVtt } = await import('../server/subs/index.ts');
const { cachePath } = await import('../server/subs/cache.ts');
const { fetchText } = await import('../server/http.ts');

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(req.url || '');
  if (req.url === '/a.srt') { res.end(SRT); return; }
  if (req.url === '/big-declared') { res.setHeader('content-length', String(6 * 1024 * 1024)); res.end(Buffer.alloc(6 * 1024 * 1024, 65)); return; }
  if (req.url === '/big-streamed') {   // no content-length: only the running count can stop it
    let sent = 0; const chunk = Buffer.alloc(256 * 1024, 65);
    const push = () => { while (sent < 8 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', push); return; } } res.end(); };
    res.on('error', () => {}); push(); return;
  }
  res.statusCode = 404; res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const noTorrent = () => undefined;
const status = (e: unknown) => (e as { status?: number }).status;

test('secret key: created once in the data dir, owner-only, same key on the next call', () => {
  const k = secretKey();
  const file = path.join(DIR, 'secret.key');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(k.length, 32);
  assert.deepEqual(secretKey(), k);
  assert.deepEqual(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'), k);
});

test('signed id round trip, and the cache key ignores the tag', () => {
  const k = { o: 'os' as const, u: 'https://example.org/s.srt', e: 'CP1252' };
  const id = encodeSubId(k);
  assert.match(id, /^[\w-]+\.[\w-]{22}$/);
  assert.deepEqual(decodeSubId(id), k);
  assert.deepEqual(decodeSubId(encodeSubId({ o: 'e', h: 'abc', i: 2, s: 3 })), { o: 'e', h: 'abc', i: 2, s: 3 });
  assert.equal(payloadOf(id), Buffer.from(JSON.stringify(k)).toString('base64url'));
  assert.equal(cachePath(id), cachePath(payloadOf(id)));
});

test('unsigned, tampered or garbled ids are a 404, never a crash', () => {
  const id = encodeSubId({ o: 'os', u: 'https://example.org/s.srt' });
  const [payload, tag] = id.split('.');
  const evil = Buffer.from(JSON.stringify({ o: 'os', u: 'http://192.168.1.1/admin' })).toString('base64url');
  const other = Buffer.alloc(32, 7);
  for (const bad of [payload, `${evil}.${tag}`, `${payload}.${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`, `${payload}.${tag}.x`, '%%%', '', '.', 'not json', encodeSubId({ o: 't', h: 'x', i: 0 }, other)]) {
    assert.throws(() => decodeSubId(bad), (e) => status(e) === 404, JSON.stringify(bad));
  }
});

test('adoptSubId: keeps its own id, re-signs bare and foreign ones to the same id, refuses anything else', () => {
  const mine = Buffer.alloc(32, 1), theirs = Buffer.alloc(32, 2);
  const k = { o: 'e' as const, h: 'abc', i: 0, s: 2 };
  const own = encodeSubId(k, mine), bare = payloadOf(own), tag = own.split('.')[1];
  assert.equal(adoptSubId(own, mine), own);
  assert.equal(adoptSubId(encodeSubId(k, theirs), mine), own);
  assert.equal(adoptSubId(bare, mine), own);
  const spaced = Buffer.from(JSON.stringify(k, null, 1)).toString('base64url');   // a key, but not as the encoder writes it
  const notKey = Buffer.from(JSON.stringify({ o: 'os', u: 7 })).toString('base64url');
  for (const bad of ['', '.', 'garbage', `${bare}.`, `${bare}.${tag}x`, `${bare}.${tag.slice(1)}`, `${own}.x`, `${spaced}.${tag}`, spaced, `${notKey}.${tag}`, notKey, 42, null, undefined, {}]) {
    assert.equal(adoptSubId(bad, mine), undefined, JSON.stringify(bad));
  }
});

test('getVtt: a signed remote id downloads once, converts, then comes from the disk cache', async () => {
  const id = encodeSubId({ o: 'os', u: `${base}/a.srt`, lan: 1 });
  const n = hits.length;
  const vtt = await getVtt(id, 0, noTorrent);
  assert.match(vtt, /^WEBVTT/); assert.match(vtt, /Hello/);
  assert.equal(await getVtt(id, 0, noTorrent), vtt);
  assert.equal(hits.length - n, 1);
});

test('getVtt: tampered and garbled ids fetch nothing and answer 404', async () => {
  const evil = Buffer.from(JSON.stringify({ o: 'os', u: `${base}/a.srt?evil` })).toString('base64url');
  const n = hits.length;
  for (const bad of [evil, `${evil}.AAAAAAAAAAAAAAAAAAAAAA`, 'garbage!!', '%%%']) {
    await assert.rejects(getVtt(bad, 0, noTorrent), (e) => status(e) === 404, bad);
  }
  assert.equal(hits.length, n);
});

test('getVtt: an unsigned id saved before signing still plays what it cached', async () => {
  const legacy = Buffer.from(JSON.stringify({ o: 'os', u: `${base}/gone.srt` })).toString('base64url');
  fs.writeFileSync(cachePath(legacy), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOld\n\n');
  const n = hits.length;
  assert.match(await getVtt(legacy, 0, noTorrent), /Old/);
  assert.equal(hits.length, n);
});

test('oversized subtitle bodies are refused, declared or streamed, and nothing is cached', async () => {
  for (const p of ['/big-declared', '/big-streamed']) {
    const id = encodeSubId({ o: 'os', u: `${base}${p}`, lan: 1 });
    await assert.rejects(getVtt(id, 0, noTorrent), (e) => status(e) === 502 && /over/.test(String(e)), p);
    assert.equal(fs.existsSync(cachePath(id)), false);
  }
  await assert.rejects(fetchText(`${base}/big-streamed`, 5000, { maxBytes: 1024, allowPrivate: true }), /over 1024 bytes/);
  assert.equal((await fetchText(`${base}/a.srt`, 5000, { maxBytes: SRT.length, allowPrivate: true })).text, SRT);
});

test('non-http addresses are refused before any fetch', async () => {
  for (const u of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.org/x', 'not a url', '']) {
    await assert.rejects(fetchText(u), (e) => status(e) === 400, u);
    await assert.rejects(getVtt(encodeSubId({ o: 'os', u }), 0, noTorrent), (e) => status(e) === 400, u);
  }
});

test('an upstream error is a 502 in words that names no URL', async () => {
  const quiet = process.stderr.write;
  process.stderr.write = (() => true) as typeof quiet;   // the warning with the URL goes to the log
  try {
    await assert.rejects(getVtt(encodeSubId({ o: 'os', u: `${base}/missing.srt`, lan: 1 }), 0, noTorrent),
      (e) => status(e) === 502 && (e as Error).message === 'The subtitle could not be downloaded (its server answered 404)');
    const big = encodeSubId({ o: 'os', u: `${base}/big-declared`, lan: 1 });
    await assert.rejects(getVtt(big, 0, noTorrent), (e) => status(e) === 502 && (e as Error).message === 'The subtitle is over 5 MB, too large to use');
  } finally { process.stderr.write = quiet; }
});
