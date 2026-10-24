import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { fetchJson, JSON_MAX_BYTES } from '../server/http.ts';
import { NO_ANSWER, REFUSED } from '../server/net-guard.ts';

/** A local server answering every request with handler. */
async function serve(handler: http.RequestListener): Promise<string> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/x.json`;
}
const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

test('fetchJson reads a normal body, BOM and all', async () => {
  const url = await serve((_q, res) => { res.setHeader('content-type', 'application/json'); res.end('﻿{"a":[1,2]}'); });
  assert.deepEqual(await fetchJson(url), { a: [1, 2] });
});

test('fetchJson refuses a body over the cap, announced or streamed', async () => {
  assert.equal(JSON_MAX_BYTES, 10 * 1024 * 1024);
  const big = '{"pad":"' + 'x'.repeat(4096) + '"}';
  const announced = await serve((_q, res) => { res.setHeader('content-length', String(big.length)); res.end(big); });
  await assert.rejects(fetchJson(announced, 2000, { maxBytes: 1024 }), /Response over 1024 bytes/);
  let sent = 0;
  const endless = await serve((_q, res) => {   // chunked, no length, never ends on its own
    const push = () => { if (res.destroyed) return; sent += 1024; res.write('x'.repeat(1024)); setImmediate(push); };
    push();
  });
  await assert.rejects(fetchJson(endless, 2000, { maxBytes: 64 * 1024 }), /Response over 65536 bytes/);
  assert.ok(sent < 4 * 1024 * 1024, `stopped reading early (${sent} bytes sent)`);
  assert.deepEqual(await fetchJson(announced, 2000, { maxBytes: big.length }), JSON.parse(big));   // at the cap is fine
});

test('fetchJson errors keep the status text and never the key', async () => {
  const url = await serve((_q, res) => { res.statusCode = 503; res.end('down'); });
  await assert.rejects(fetchJson(`${url}?token=SECRET`), (e: Error) => /^503 /.test(e.message) && !e.message.includes('SECRET'));
});

test('fetchJson with a guard: same caps, gzip undone, a body that stalls is no answer, a private target refused', async () => {
  const lan = { allowPrivate: true, what: 'addon' } as const;
  const big = '{"pad":"' + 'x'.repeat(4096) + '"}';
  const announced = await serve((_q, res) => { res.setHeader('content-length', String(big.length)); res.end(big); });
  await assert.rejects(fetchJson(announced, 2000, { maxBytes: 1024, guard: lan }), /Response over 1024 bytes/);
  assert.deepEqual(await fetchJson(announced, 2000, { maxBytes: big.length, guard: lan }), JSON.parse(big));
  let sent = 0;
  const endless = await serve((_q, res) => { const push = () => { if (res.destroyed) return; sent += 1024; res.write('x'.repeat(1024)); setImmediate(push); }; push(); });
  await assert.rejects(fetchJson(endless, 2000, { maxBytes: 64 * 1024, guard: lan }), /Response over 65536 bytes/);
  assert.ok(sent < 4 * 1024 * 1024, `stopped reading early (${sent} bytes sent)`);
  const gz = await serve((q, res) => { res.writeHead(200, { 'content-encoding': /gzip/.test(String(q.headers['accept-encoding'])) ? 'gzip' : 'identity' }); res.end(zlib.gzipSync('{"a":1}')); });
  assert.deepEqual(await fetchJson(gz, 2000, { guard: lan }), { a: 1 });
  const stall = await serve((_q, res) => { res.writeHead(200); res.write('{"a":'); });
  await assert.rejects(fetchJson(stall, 200, { guard: lan }), { code: NO_ANSWER, status: 502, message: 'The addon did not answer in time' });
  const down = await serve((_q, res) => { res.statusCode = 503; res.end('down'); });
  await assert.rejects(fetchJson(`${down}?token=SECRET`, 2000, { guard: lan }), (e: Error) => /^503 Service Unavailable for /.test(e.message) && !e.message.includes('SECRET'));
  await assert.rejects(fetchJson(announced, 2000, { guard: { allowPrivate: false, what: 'addon' } }), { code: REFUSED, status: 403, message: 'That addon points at a private network address' });
});
