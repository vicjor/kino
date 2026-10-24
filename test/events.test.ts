import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';
import { addClient, emit, send, clientCount, MAX_BUFFERED_BYTES } from '../server/events.ts';

/** A stand-in SSE response. `stalled`: the client reads nothing, so every write stays buffered. */
class FakeRes extends EventEmitter {
  chunks: string[] = []; writableLength = 0; destroyed = false; writableEnded = false;
  constructor(public stalled = false) { super(); }
  writeHead() { return this; }
  write(c: string) { this.chunks.push(c); if (this.stalled) this.writableLength += Buffer.byteLength(c); return !this.stalled; }
  end() { this.writableEnded = true; this.emit('close'); return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
const quiet = (fn: () => void) => { const w = process.stderr.write; process.stderr.write = (() => true) as typeof w; try { fn(); } finally { process.stderr.write = w; } };
const stats = (n: number) => ({ infoHash: 'a'.repeat(40), name: 'x'.repeat(n) }) as never;

test('a client that stops reading is dropped once more than about 1 MB waits for it; the others get every event', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const reading = new FakeRes(), stalled = new FakeRes(true);
  addClient(reading as unknown as Response); addClient(stalled as unknown as Response);
  assert.equal(clientCount(), 2);
  const n = Math.ceil(MAX_BUFFERED_BYTES / 100_000) + 3;
  quiet(() => { for (let i = 0; i < n; i++) emit('torrent.stats', stats(100_000)); });
  assert.equal(stalled.destroyed, true, 'destroyed, not ended: end() would hold the buffer until it is read');
  assert.ok(stalled.writableLength > MAX_BUFFERED_BYTES && stalled.writableLength < MAX_BUFFERED_BYTES + 200_000, `${stalled.writableLength} bytes`);
  const got = stalled.chunks.length;
  assert.equal(clientCount(), 1);
  emit('torrent.stats', stats(10)); send(stalled as unknown as Response, 'torrent.stats', stats(10));
  t.mock.timers.tick(20_000);   // a ping
  assert.equal(stalled.chunks.length, got, 'nothing more is written to a dropped client');
  assert.equal(reading.destroyed, false);
  assert.equal(reading.chunks.filter((c) => c.startsWith('event: torrent.stats')).length, n + 1);
  assert.equal(reading.chunks.at(-1), ': ping\n\n');
  reading.emit('close');
  assert.equal(clientCount(), 0);
});

test('a client that falls behind on pings alone is dropped too', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const slow = new FakeRes(true);
  addClient(slow as unknown as Response);
  slow.writableLength = MAX_BUFFERED_BYTES - 8;   // a ping (8 bytes) lands right at the limit: still fine
  t.mock.timers.tick(20_000);
  assert.equal(slow.writableLength, MAX_BUFFERED_BYTES);
  assert.equal(slow.destroyed, false);
  quiet(() => { t.mock.timers.tick(20_000); });
  assert.equal(slow.destroyed, true);
  assert.equal(clientCount(), 0);
});

test('over a real socket: a response nobody reads is destroyed and leaves the set', async () => {
  const srv = http.createServer((_req, res) => addClient(res as unknown as Response));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const req = http.get({ host: '127.0.0.1', port, path: '/' });
  const res = await new Promise<http.IncomingMessage>((r) => req.once('response', r));
  res.pause();   // the page is asleep: nothing is read
  try {
    const big = stats(256 * 1024);
    let rounds = 0;
    const closed = new Promise((r) => res.once('close', r));
    quiet(() => { while (clientCount() > 0 && rounds < 200) { emit('torrent.stats', big); rounds++; } });
    assert.equal(clientCount(), 0, 'dropped');
    assert.ok(rounds <= 8, `about 1 MB held, not more (dropped after ${rounds} events of 256 KB)`);
    await closed;   // the server let go of the connection
  } finally { req.destroy(); srv.closeAllConnections(); srv.close(); }
});
