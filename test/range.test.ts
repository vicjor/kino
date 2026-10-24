import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Torrent } from 'webtorrent';
import express from 'express';
const { parseRange, serveFile } = await import('../server/media/range.ts');

const SIZE = 1000;
const ok = (start: number, end: number) => ({ status: 206, start, end });
const NO = { status: 416 };

test('parseRange: open end, plain range, suffix', () => {
  assert.deepEqual(parseRange('bytes=0-', SIZE), ok(0, 999));
  assert.deepEqual(parseRange('bytes=100-199', SIZE), ok(100, 199));
  assert.deepEqual(parseRange('bytes=-500', SIZE), ok(500, 999));
  assert.deepEqual(parseRange('bytes=-5000', SIZE), ok(0, 999), 'a suffix longer than the file is the whole file');
  assert.deepEqual(parseRange('bytes=999-999', SIZE), ok(999, 999), 'the last byte');
});

test('parseRange: an end at or past the size is clamped, not refused (DLNA renderers send bytes=0-<huge>)', () => {
  assert.deepEqual(parseRange('bytes=0-99999999999', SIZE), ok(0, 999));
  assert.deepEqual(parseRange(`bytes=0-${SIZE}`, SIZE), ok(0, 999));
  assert.deepEqual(parseRange('bytes=500-99999999999999999999999', SIZE), ok(500, 999));
});

test('parseRange: 416 when nothing asked for is in the file, or the header is malformed', () => {
  assert.deepEqual(parseRange(`bytes=${SIZE}-`, SIZE), NO, 'start at the size');
  assert.deepEqual(parseRange('bytes=5000-6000', SIZE), NO);
  assert.deepEqual(parseRange('bytes=-0', SIZE), NO, 'a zero suffix');
  assert.deepEqual(parseRange('bytes=200-100', SIZE), NO, 'start after end');
  for (const bad of ['garbage', 'bytes=abc', 'bytes=-', 'bytes=', 'bytes=1-2-3', 'bytes=0x10-', '0-100']) assert.deepEqual(parseRange(bad, SIZE), NO, bad);
  assert.deepEqual(parseRange('bytes=0-', 0), NO, 'nothing is in an empty file');
  assert.deepEqual(parseRange('bytes=-10', 0), NO);
});

test('parseRange: no header or an unknown unit is the whole file; the unit is case-insensitive', () => {
  assert.deepEqual(parseRange(undefined, SIZE), { status: 200 });
  assert.deepEqual(parseRange('items=0-5', SIZE), { status: 200 });
  assert.deepEqual(parseRange('Bytes=0-9', SIZE), ok(0, 9));
});

test('parseRange: several ranges serve the first one that is in the file, as one plain range', () => {
  assert.deepEqual(parseRange('bytes=0-99,200-299', SIZE), ok(0, 99));
  assert.deepEqual(parseRange('bytes=0-99, 200-299', SIZE), ok(0, 99), 'spaces after the comma');
  assert.deepEqual(parseRange('bytes=5000-,200-299', SIZE), ok(200, 299), 'past the end first: the next one');
  assert.deepEqual(parseRange('bytes=5000-,6000-', SIZE), NO, 'none in the file');
  assert.deepEqual(parseRange('bytes=0-99,junk', SIZE), NO, 'one malformed spec refuses the lot');
});

// serveFile over a fake torrent. HEAD and 416 answer before the file is opened, so no torrent is needed.
const torrent = { infoHash: 'f'.repeat(40), files: [{ name: 'Film.mkv', length: SIZE }] } as unknown as Torrent;
const app = express();
app.all('/api/file/:idx', (req, res) => serveFile(req, res, torrent, Number(req.params.idx)));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file/0`;
after(() => { server.closeAllConnections(); server.close(); });
const head = (range?: string) => fetch(url, { method: 'HEAD', headers: range ? { range } : {} });

test('serveFile: a huge end is a 206 to the last byte, with the range headers and CORS *', async () => {
  const r = await head('bytes=0-99999999999');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-999/${SIZE}`);
  assert.equal(r.headers.get('content-length'), '1000');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('content-type'), 'video/x-matroska');
});

test('serveFile: no range is a 200 of the whole file; past the end is a 416 that names the size', async () => {
  const all = await head();
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('content-length'), '1000');
  assert.equal(all.headers.get('content-range'), null);
  assert.equal(all.headers.get('accept-ranges'), 'bytes');
  const past = await head(`bytes=${SIZE}-`);
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(past.headers.get('access-control-allow-origin'), '*');
  const suffix = await head('bytes=-100');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes 900-999/${SIZE}`);
});
