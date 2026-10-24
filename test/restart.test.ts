import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';

/**
 * scripts/restart.sh with launchctl stubbed on PATH (it logs its arguments and keeps the service's state in a file:
 * none is not loaded) and a fake /health on a random port: a restart only counts once /health answers from the new process.
 * lsof is stubbed too (stop mode): the port listens for as many checks as the LISTEN file says.
 */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/restart.sh');
const run = promisify(execFile);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-restart-'));
const BIN = path.join(TMP, 'bin'), CALLS = path.join(TMP, 'launchctl.log'), ERRLOG = path.join(TMP, 'kino.error.log');
const STATE = path.join(TMP, 'launchd-state'), LISTEN = path.join(TMP, 'listen'), PLIST = path.join(TMP, 'Library/LaunchAgents/com.kino.plist');
fs.mkdirSync(BIN); fs.mkdirSync(path.dirname(PLIST), { recursive: true }); fs.writeFileSync(PLIST, '<plist/>\n');
// STUCK=1: bootout leaves the service loaded.
fs.writeFileSync(path.join(BIN, 'launchctl'), `#!/bin/sh
echo "$*" >>"${CALLS}"
case $1 in
  print) [ -f "${STATE}" ] || exit 113; cat "${STATE}" ;;
  bootout) [ "$STUCK" = 1 ] || rm -f "${STATE}" ;;
  bootstrap | kickstart) echo "state = running" >"${STATE}" ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'lsof'), `#!/bin/sh
echo "lsof $*" >>"${CALLS}"
n=$(cat "${LISTEN}" 2>/dev/null || echo 0)
[ "$n" -gt 0 ] || exit 1
echo $((n - 1)) >"${LISTEN}"
`, { mode: 0o755 });
fs.writeFileSync(ERRLOG, 'Error: listen EADDRINUSE :::1234\n');

/** Replies in order, the last one repeated. A number is an uptime in seconds, null a 503 from a server shutting down. */
let replies: (number | null)[] = [];
const server = http.createServer((_req, res) => {
  const up = replies.length > 1 ? replies.shift()! : replies[0];
  if (up === null) { res.writeHead(503); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, version: '1.0.0', uptime: up, busy: false }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const PORT = (server.address() as AddressInfo).port, URL = `http://127.0.0.1:${PORT}`;
after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

type Opts = { state?: 'running' | 'not running' | null; how?: string; stuck?: boolean; home?: string; listen?: number };
async function restart(seq: (number | null)[], { state = 'running', how, stuck, home = TMP, listen = 0 }: Opts = {}): Promise<{ code: number; out: string; calls: string[] }> {
  replies = seq; fs.rmSync(CALLS, { force: true }); fs.writeFileSync(LISTEN, String(listen));
  if (state) fs.writeFileSync(STATE, `state = ${state}\n`); else fs.rmSync(STATE, { force: true });
  const env = { PATH: `${BIN}:${process.env.PATH}`, HOME: home, WAIT_S: '3', KINO_ERROR_LOG: ERRLOG, STUCK: stuck ? '1' : '0' };
  let code = 0, out = '';
  try { out = (await run('sh', [SCRIPT, URL, ...(how ? [how] : [])], { env })).stdout; } catch (e) { const x = e as { code: number; stdout: string }; code = x.code; out = x.stdout; }
  return { code, out, calls: fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n') : [] };
}
/** The launchctl calls that change something: print only looks. */
const acts = (calls: string[]) => calls.filter((c) => !c.startsWith('print '));
const uid = process.getuid!();

test('restart: kickstarts a loaded service and returns once /health comes from the new process', async () => {
  const r = await restart([0]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, [`print gui/${uid}/com.kino`, `kickstart -k gui/${uid}/com.kino`]);
});

test('restart: waits through the old process answering and a 503 while it stops', async () => {
  const r = await restart([86400, null, 0]);
  assert.equal(r.code, 0, r.out);
  assert.equal(replies.length, 1, 'kept asking until the new process answered');
});

test('restart: an unloaded service is bootstrapped from its plist', async () => {
  const r = await restart([0], { state: null });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not loaded/);
  assert.deepEqual(r.calls, [`print gui/${uid}/com.kino`, `bootstrap gui/${uid} ${PLIST}`]);
});

test('restart: an unloaded service with no plist fails at once, saying make install-local', async () => {
  const empty = path.join(TMP, 'empty-home'); fs.mkdirSync(empty, { recursive: true });
  for (const how of ['restart', 'start', 'reload']) {
    const r = await restart([0], { state: null, how, home: empty });
    assert.equal(r.code, 1, how);
    assert.match(r.out, /no .*com\.kino\.plist to load\. make install-local/, how);
    assert.deepEqual(acts(r.calls), [], how);
  }
});

test('restart: an unknown way is refused before launchctl', async () => {
  const r = await restart([0], { how: 'kick' });
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls, []);
});

test('restart start: a running service is not restarted, any /health from it will do', async () => {
  const r = await restart([null, 86400], { how: 'start' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Already running, not restarted/);
  assert.deepEqual(acts(r.calls), []);
  assert.equal(replies.length, 1, 'waited past the 503');
});

test('restart start: a loaded service that is not running is started, and waited for', async () => {
  const r = await restart([86400, null, 0], { how: 'start', state: 'not running' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(acts(r.calls), [`kickstart gui/${uid}/com.kino`]);
  assert.equal(replies.length, 1, 'kept asking until the new process answered');
});

test('restart start: after make stop-local, bootstraps the plist and fails when nothing new answers', async () => {
  const ok = await restart([0], { how: 'start', state: null });
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(acts(ok.calls), [`bootstrap gui/${uid} ${PLIST}`]);
  const down = await restart([86400], { how: 'start', state: null });
  assert.equal(down.code, 1);
  assert.match(down.out, /^Started, but .*does not answer from the new process/m);
  assert.match(down.out, /EADDRINUSE/);
});

test('restart reload: bootout, then the plist bootstrapped again (a kickstart would keep the old plist)', async () => {
  const r = await restart([86400, null, 0], { how: 'reload' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(acts(r.calls), [`bootout gui/${uid}/com.kino`, `bootstrap gui/${uid} ${PLIST}`]);
  assert.doesNotMatch(r.out, /not loaded/);
  assert.equal(replies.length, 1, 'kept asking until the new process answered');
  const first = await restart([0], { how: 'reload', state: null });
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(acts(first.calls), [`bootstrap gui/${uid} ${PLIST}`], 'first install: nothing to bootout');
});

test('restart reload: a service launchd never lets go of is not bootstrapped over', async () => {
  const r = await restart([0], { how: 'reload', stuck: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /still has com\.kino loaded after bootout/);
  assert.deepEqual(acts(r.calls), [`bootout gui/${uid}/com.kino`]);
});

test('restart: an old process that never goes away fails after WAIT_S tries, with the error log', async () => {
  const r = await restart([86400]);
  assert.equal(r.code, 1);
  assert.match(r.out, /does not answer from the new process/);
  assert.match(r.out, /EADDRINUSE/);
});

const lsof = `lsof -nP -iTCP:${PORT} -sTCP:LISTEN`;

test('restart stop: bootout, then waits until nothing listens on the port', async () => {
  const r = await restart([0], { how: 'stop', listen: 2 });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(acts(r.calls), [`bootout gui/${uid}/com.kino`, lsof, lsof, lsof]);
  assert.match(r.out, new RegExp(`^Kino stopped on this Mac, port ${PORT} is free$`, 'm'));
});

test('restart stop: a service that is not loaded is not booted out, and not bootstrapped either', async () => {
  const r = await restart([0], { how: 'stop', state: null });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(acts(r.calls), [lsof]);
  assert.match(r.out, /com\.kino was not loaded/);
});

test('restart stop: a port that never frees fails after WAIT_S tries', async () => {
  const r = await restart([0], { how: 'stop', listen: 99 });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`still holding port ${PORT}`));
  assert.equal(acts(r.calls).filter((c) => c === lsof).length, 3);
});

test('restart stop: a service launchd never lets go fails before the port is checked', async () => {
  const r = await restart([0], { how: 'stop', stuck: true, listen: 1 });
  assert.equal(r.code, 1);
  assert.match(r.out, /still has com\.kino loaded after bootout, so Kino may still be running/);
  assert.deepEqual(acts(r.calls), [`bootout gui/${uid}/com.kino`]);
});
