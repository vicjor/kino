import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { devPorts, answering, refusal } from '../scripts/dev-guard.ts';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'dev-guard.ts');
const listen = async (s: net.Server): Promise<number> => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return (s.address() as AddressInfo).port; };

const kino = http.createServer((req, res) => {
  if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, version: '9.9.9', uptime: 5, busy: true })); }
  else { res.statusCode = 404; res.end(); }
});
const other = http.createServer((_req, res) => { res.statusCode = 404; res.end('not here'); });
const silent = net.createServer(() => { /* accepts and never answers */ });
const kinoPort = await listen(kino), otherPort = await listen(other), silentPort = await listen(silent);
const freePort = await (async () => { const s = net.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; })();
after(() => { kino.close(); other.close(); silent.close(); });

test('devPorts: the API port and the proxied one, 1234 when unset, once each', () => {
  assert.deepEqual(devPorts({}), [1234]);
  assert.deepEqual(devPorts({ PORT: '1299' }), [1299, 1234]);
  assert.deepEqual(devPorts({ KINO_API_PORT: '1299' }), [1234, 1299]);
  assert.deepEqual(devPorts({ PORT: '1299', KINO_API_PORT: '1299' }), [1299]);
});

test('answering: a Kino by its version, anything else by its status, nothing on a free port', async () => {
  assert.equal(await answering(kinoPort), 'Kino 9.9.9, someone is watching');
  assert.equal(await answering(otherPort), 'HTTP 404');
  assert.equal(await answering(freePort), null);
  assert.equal(await answering(silentPort, 200), 'no answer within 200 ms', 'a port that accepts and stays silent is taken');
});

test('refusal names the port, what answers, and both ways on', () => {
  const text = refusal([[1234, 'Kino 0.2.0']]);
  assert.match(text, /:1234 \(Kino 0\.2\.0\)/);
  assert.match(text, /bun run dev:iso/);
  assert.match(text, /KINO_DEV_ATTACH=1 bun run dev/);
});

/** Runs the script as `bun run dev` does, with plain node, both ports always set so it never looks at 1234. */
function run(port: number, extra: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  const env = { PATH: process.env.PATH, PORT: String(port), KINO_API_PORT: String(port), ...extra };
  return new Promise((resolve) => execFile(process.execPath, [SCRIPT], { env, encoding: 'utf8' }, (e, _out, stderr) => resolve({ code: e ? Number(e.code) : 0, stderr })));
}

test('the script refuses when the port answers, unless KINO_DEV_ATTACH=1, and passes on a free port', async () => {
  const busy = await run(kinoPort);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, new RegExp(`:${kinoPort} \\(Kino 9\\.9\\.9`));
  assert.match(busy.stderr, /bun run dev:iso/);
  assert.deepEqual(await run(kinoPort, { KINO_DEV_ATTACH: '1' }), { code: 0, stderr: '' });
  assert.deepEqual(await run(freePort), { code: 0, stderr: '' });
});
