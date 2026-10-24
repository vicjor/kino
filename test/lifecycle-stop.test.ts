import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket, AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import express from 'express';
import { killOnShutdown, killChildren, runShutdown, refuseWhileStopping, type ShutdownSteps } from '../server/lifecycle.ts';

// runShutdown marks the module as stopping for good, so these tests run in order, before and after it.
const sleeper = () => spawn('sleep', ['30'], { stdio: 'ignore' });
const exited = (p: ChildProcess) => new Promise<NodeJS.Signals | null>((r) => p.once('exit', (_code, sig) => r(sig)));
const quiet: ShutdownSteps = { flush: () => undefined, now: [], cast: async () => undefined, torrent: async () => undefined, closeHttp: () => undefined };

// The app as server/index.ts starts it: the stopping check first.
const app = express();
app.use(refuseWhileStopping);
app.get('/x', (_req, res) => { res.json({ ok: true }); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });   // one connection, kept alive between requests
after(() => { agent.destroy(); server.closeAllConnections(); server.close(); });
const get = () => new Promise<{ status?: number; connection?: string; body: { ok?: boolean; error?: string }; socket: Socket }>((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/x', agent }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: JSON.parse(b), socket: req.socket! }));
  });
  req.on('error', reject);
});

test('killChildren: kills a helper still running, forgets one that ended', async () => {
  const quick = killOnShutdown(spawn('true'));
  await exited(quick);
  const slow = killOnShutdown(sleeper());
  const sig = exited(slow);
  assert.equal(killChildren(), 1);
  assert.equal(await sig, 'SIGKILL');
  assert.equal(killChildren(), 0);
});

test('runShutdown: helpers are killed, a later one at once, and a kept-alive connection gets a 503 and is closed', async () => {
  const before = await get();
  assert.deepEqual([before.status, before.connection, before.body], [200, 'keep-alive', { ok: true }]);
  const closed = new Promise((r) => before.socket.once('close', r));
  const helper = exited(killOnShutdown(sleeper()));

  await runShutdown(quiet, { castMs: 10, totalMs: 50 });
  assert.equal(await helper, 'SIGKILL');
  const late = sleeper(); const sig = exited(late);
  killOnShutdown(late);
  assert.equal(await sig, 'SIGKILL');
  assert.equal(killChildren(), 0, 'not kept');

  const during = await get();
  assert.equal(during.socket, before.socket, 'the same kept-alive connection');
  assert.deepEqual([during.status, during.connection, during.body], [503, 'close', { error: 'Kino is stopping. Try again in a moment.' }]);
  await closed;
});
