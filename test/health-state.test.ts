import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';

/** scripts/health-state.sh against a fake /health on a random port: what the deploy guards act on. */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/health-state.sh');
const run = promisify(execFile);
let reply: { status: number; body: string } = { status: 200, body: '{}' };
const server = http.createServer((_req, res) => { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(reply.body); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function stateFor(status: number, body: unknown): Promise<string> {
  reply = { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
  return (await run('sh', [SCRIPT, URL])).stdout.trim();
}
const NOW = { ok: true, streams: 0, hlsSessions: 0, cast: false, castDevices: 2 };

test('health-state: the server busy flag decides', async () => {
  assert.equal(await stateFor(200, { ...NOW, streams: 1, busy: true }), 'busy');
  assert.equal(await stateFor(200, { ...NOW, busy: false }), 'idle');
});

test('health-state: the short /health a PIN gives callers without the cookie still decides', async () => {
  assert.equal(await stateFor(200, { ok: true, version: '1.0.0', uptime: 42, busy: true }), 'busy');
  assert.equal(await stateFor(200, { ok: true, version: '1.0.0', uptime: 42, busy: false }), 'idle');
});

test('health-state: a busy-looking string elsewhere in the json cannot fake the flag', async () => {
  assert.equal(await stateFor(200, { hostname: '"busy":true', ...NOW, busy: false }), 'idle');
});

test('health-state: no answer or an error status is down, not idle', async () => {
  assert.equal(await stateFor(500, 'oops'), 'down');
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  assert.equal((await run('sh', [SCRIPT, `http://127.0.0.1:${port}`])).stdout.trim(), 'down');
});

test('health-state: a build from before the busy flag falls back to its counters', async () => {
  const old = { ok: true, streams: 0, hlsSessions: 0, cast: false, castDevices: 2 };
  assert.equal(await stateFor(200, old), 'idle');
  assert.equal(await stateFor(200, { ...old, streams: 1 }), 'busy');
  assert.equal(await stateFor(200, { ...old, hlsSessions: 10 }), 'busy');
  assert.equal(await stateFor(200, { ...old, cast: true }), 'busy');
});

test('health-state: something that is not Kino answering counts as busy', async () => {
  assert.equal(await stateFor(200, '<html>hello</html>'), 'busy');
});
