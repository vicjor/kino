import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { fakeClient } from './fake-build.ts';

/**
 * make stop-local, install-local and deploy-local, nowhere near production: the Makefile, scripts and plist in a scratch
 * git repo, launchctl, lsof and bun stubbed on PATH (bun's builds copy a prepared build in), a fake /health on a random
 * port (LOCAL_URL), a scratch HOME and a made-up LABEL. Each refuses while someone is watching (FORCE=1 overrides) or
 * while another deploy holds the lock (FORCE does not); install-local and deploy-local hold the lock and build aside.
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-make-local-'));
const REPO = path.join(TMP, 'repo'), BIN = path.join(TMP, 'bin'), HOME = path.join(TMP, 'home');
const CALLS = path.join(TMP, 'calls.log'), STATE = path.join(TMP, 'launchd-state');
const LOCK = path.join(REPO, '.git/kino-deploy-safe.lock');
const LABEL = 'com.kino.make-local-test';
const run = promisify(execFile);

/** /health replies in order, the last one repeated: busy or not. uptime 0, so a restart's wait ends at once. */
let replies: boolean[] = [false];
const server = http.createServer((_req, res) => {
  const busy = replies.length > 1 ? replies.shift()! : replies[0];
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, uptime: 0, busy }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

fs.mkdirSync(REPO); fs.mkdirSync(BIN); fs.mkdirSync(HOME);
for (const d of ['scripts', 'launchd']) fs.cpSync(path.join(ROOT, d), path.join(REPO, d), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'Makefile'), path.join(REPO, 'Makefile'));
execFileSync('git', ['init', '-q'], { cwd: REPO, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

function fakeBuild(name: string): string {
  const dir = path.join(TMP, 'builds', name);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server/index.js'), `// ${name}\n`);
  fakeClient(path.join(dir, 'client'));
  return dir;
}
const OLD = fakeBuild('old'), NEW = fakeBuild('new');

// Every stub logs its call, bun with the deploy lock's holder at that moment (none when free).
fs.writeFileSync(path.join(BIN, 'launchctl'), `#!/bin/sh
echo "launchctl $*" >>"${CALLS}"
case $1 in
  print) [ -f "${STATE}" ] || exit 113; cat "${STATE}" ;;
  bootout) rm -f "${STATE}" ;;
  bootstrap | kickstart) echo "state = running" >"${STATE}" ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'lsof'), `#!/bin/sh\necho "lsof" >>"${CALLS}"\nexit 1\n`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'bun'), `#!/bin/sh
echo "bun $1 $2 (lock: $(cat "${LOCK}/name" 2>/dev/null || echo none))" >>"${CALLS}"
case "$1 $2" in
  "run build:server" | "run build:client") mkdir -p "$(dirname "$4")"; cp -R "${NEW}/\${2#build:}" "$4" ;;
  "scripts/verify-build.ts "*) exec node "$@" ;;
  *) echo "unexpected: bun $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
const env = { PATH: `${BIN}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME, WAIT_S: '2' };
// Never the real launchctl: it would stop or restart production.
assert.equal(execFileSync('sh', ['-c', 'command -v launchctl'], { env, encoding: 'utf8' }).trim(), path.join(BIN, 'launchctl'));
// /usr/bin/make refuses until the Xcode license is agreed to after a macOS update; the Command Line Tools one does not.
const MAKE = ['make', '/Library/Developer/CommandLineTools/usr/bin/make'].find((m) => spawnSync(m, ['--version']).status === 0);

beforeEach(() => {
  for (const d of ['dist', 'dist.prev', 'dist.new']) fs.rmSync(path.join(REPO, d), { recursive: true, force: true });
  fs.cpSync(OLD, path.join(REPO, 'dist'), { recursive: true });
  fs.rmSync(path.join(HOME, 'Library'), { recursive: true, force: true });
  fs.rmSync(LOCK, { recursive: true, force: true });
  fs.rmSync(CALLS, { force: true });
  fs.writeFileSync(STATE, 'state = running\n');
  replies = [false];
});

async function make(target: string, vars: string[] = []): Promise<{ code: number; out: string }> {
  const args = ['--no-print-directory', '-C', REPO, `LOCAL_URL=${URL}`, `LABEL=${LABEL}`, ...vars, target];
  try { const r = await run(MAKE!, args, { env }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
}
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n') : []);
/** The calls that change something: launchctl print only looks. */
const acts = () => calls().filter((c) => !c.startsWith('launchctl print'));
const serving = (d = 'dist') => fs.readFileSync(path.join(REPO, d, 'server/index.js'), 'utf8');
const dists = () => fs.readdirSync(REPO).filter((f) => f.startsWith('dist')).sort();
const PLIST = path.join(HOME, `Library/LaunchAgents/${LABEL}.plist`);
const svc = `gui/${process.getuid!()}/${LABEL}`;
/** Another deploy (deploy-safe, by its name) holding the lock with a live pid. */
function otherDeploy() { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'pid'), `${process.pid}\n`); fs.writeFileSync(path.join(LOCK, 'name'), 'make deploy-safe\n'); }
const skip = MAKE ? false : 'no working make';

test('make stop-local: refuses while someone is watching, FORCE=1 stops anyway', { skip }, async () => {
  replies = [true];
  const r = await make('stop-local');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Someone is watching .* and stopping Kino ends it\. Re-run with FORCE=1, or once nobody is watching\./);
  assert.deepEqual(acts(), []);
  const f = await make('stop-local', ['FORCE=1']);
  assert.equal(f.code, 0, f.out);
  assert.deepEqual(acts(), [`launchctl bootout ${svc}`, 'lsof']);
  assert.match(f.out, /Kino stopped on this Mac/);
});

test('make stop-local: nobody watching stops at once; another deploy running refuses even with FORCE=1', { skip }, async () => {
  const r = await make('stop-local');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(acts(), [`launchctl bootout ${svc}`, 'lsof']);
  fs.rmSync(CALLS); fs.writeFileSync(STATE, 'state = running\n');
  otherDeploy();
  const f = await make('stop-local', ['FORCE=1']);
  assert.equal(f.code, 2, f.out);
  assert.match(f.out, /make deploy-safe is running \(pid \d+\)/);
  assert.deepEqual(calls(), []);
});

test('make install-local: builds aside under the deploy lock, swaps, copies the plist, reloads, lets the lock go', { skip }, async () => {
  const r = await make('install-local');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Kino is live at/);
  assert.equal(serving(), '// new\n');
  assert.equal(serving('dist.prev'), '// old\n');
  assert.deepEqual(dists(), ['dist', 'dist.prev']);
  assert.equal(fs.readFileSync(PLIST, 'utf8'), execFileSync('sh', ['scripts/plist.sh'], { cwd: fs.realpathSync(REPO), env, encoding: 'utf8' }));
  assert.deepEqual(acts(), [
    'bun run build:server (lock: make install-local)', 'bun run build:client (lock: make install-local)',
    'bun scripts/verify-build.ts dist.new/client (lock: make install-local)',
    `launchctl bootout ${svc}`, `launchctl bootstrap gui/${process.getuid!()} ${PLIST}`,
  ]);
  assert.equal(fs.existsSync(LOCK), false, 'deploy lock released');
});

test('make install-local: a first install with no dist/ yet gets one, and no dist.prev', { skip }, async () => {
  fs.rmSync(path.join(REPO, 'dist'), { recursive: true });
  fs.rmSync(STATE);
  const r = await make('install-local');
  assert.equal(r.code, 0, r.out);
  assert.equal(serving(), '// new\n');
  assert.deepEqual(dists(), ['dist']);
  assert.deepEqual(acts().filter((c) => c.startsWith('launchctl')), [`launchctl bootstrap gui/${process.getuid!()} ${PLIST}`]);
});

test('make install-local: someone watching before the build builds nothing; after it, nothing changes', { skip }, async () => {
  replies = [true];
  const before = await make('install-local');
  assert.equal(before.code, 2, before.out);
  assert.match(before.out, /a restart stops it\. Re-run with FORCE=1, or once nobody is watching\./);
  assert.deepEqual(acts(), []);
  assert.equal(fs.existsSync(LOCK), false, 'deploy lock released');

  replies = [false, true];
  const during = await make('install-local');
  assert.equal(during.code, 2, during.out);
  assert.match(during.out, /Someone started watching during the build\. Nothing changed\. Re-run with FORCE=1, or once nobody is watching\./);
  assert.equal(serving(), '// old\n');
  assert.deepEqual(dists(), ['dist'], 'dist.new removed, dist/ untouched');
  assert.equal(fs.existsSync(PLIST), false);
  assert.deepEqual(acts().filter((c) => c.startsWith('launchctl')), []);
  assert.equal(fs.existsSync(LOCK), false, 'deploy lock released');
});

test('make install-local: refuses while another deploy holds the lock, even with FORCE=1, and builds nothing', { skip }, async () => {
  otherDeploy();
  const r = await make('install-local', ['FORCE=1']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /make deploy-safe is running \(pid \d+\)/);
  assert.deepEqual(calls(), []);
  assert.equal(fs.readFileSync(path.join(LOCK, 'name'), 'utf8').trim(), 'make deploy-safe', 'the other lock is left alone');
});

test('make deploy-local: the shared build-aside swaps and restarts, and its busy message points at deploy-safe', { skip }, async () => {
  const r = await make('deploy-local', ['DIRTY=1']);   // the scratch repo has no commits: every file differs from HEAD
  assert.equal(r.code, 0, r.out);
  assert.equal(serving(), '// new\n');
  assert.equal(serving('dist.prev'), '// old\n');
  assert.deepEqual(acts().filter((c) => c.startsWith('launchctl')), [`launchctl kickstart -k ${svc}`]);
  assert.match(calls()[0], /^bun run build:server \(lock: make deploy-local\)$/);
  assert.equal(fs.existsSync(PLIST), false, 'the plist is install-local\'s');

  fs.rmSync(CALLS); replies = [false, true];
  const during = await make('deploy-local', ['DIRTY=1']);
  assert.equal(during.code, 2, during.out);
  assert.match(during.out, /Nothing changed\. Re-run with FORCE=1, or deploy with make deploy-safe \(it waits\)\./);
  assert.equal(serving(), '// new\n');
  assert.deepEqual(acts().filter((c) => c.startsWith('launchctl')), []);
  assert.equal(fs.existsSync(LOCK), false, 'deploy lock released');
});
