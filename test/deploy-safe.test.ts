import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { fakeClient } from './fake-build.ts';

/**
 * scripts/deploy-safe.sh end to end, nowhere near production: the repo's scripts and Makefile committed in a scratch
 * git repo, launchctl and bun stubbed on PATH (`bun run build` copies a prepared build in), a fake /health on a random
 * port, a scratch HOME, a made-up service label and IDLE_MIN=0. A build that fails scripts/verify-build.ts must never
 * reach dist/ or launchctl.
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-deploy-safe-'));
const REPO = path.join(TMP, 'repo'), BIN = path.join(TMP, 'bin'), HOME = path.join(TMP, 'home'), CALLS = path.join(TMP, 'launchctl.log');
const LABEL = 'com.kino.deploy-safe-test';
const run = promisify(execFile);

const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"uptime":0,"busy":false}'); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// deploy-safe builds committed HEAD in a worktree of its repo and runs HEAD's verify-build there.
fs.mkdirSync(REPO); fs.mkdirSync(BIN); fs.mkdirSync(HOME);
fs.cpSync(path.join(ROOT, 'scripts'), path.join(REPO, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'Makefile'), path.join(REPO, 'Makefile'));
const gitEnv = { ...process.env, HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@kino.invalid', ...args], { cwd: REPO, env: gitEnv, encoding: 'utf8' });
git('init', '-q'); git('add', 'scripts', 'Makefile'); git('commit', '-q', '-m', 'scratch');

/** A whole build (server/index.js says which) whose client lacks `leave`. */
function fakeBuild(name: string, leave: string[] = []): string {
  const dir = path.join(TMP, 'builds', name);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server/index.js'), `// ${name}\n`);
  fakeClient(path.join(dir, 'client'), leave);
  return dir;
}
const OLD = fakeBuild('old'), GOOD = fakeBuild('good'), BROKEN = fakeBuild('broken', ['/assets/Player-c3.js']);

fs.writeFileSync(path.join(BIN, 'launchctl'), `#!/bin/sh\necho "$*" >>"${CALLS}"\n[ "$1" = print ] && echo "state = running"\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'bun'), `#!/bin/sh\n[ "$*" = "run build" ] || { echo "unexpected: bun $*" >&2; exit 9; }\ncp -R "$FAKE_BUILD" dist\n`, { mode: 0o755 });
const env = { PATH: `${BIN}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME, URL, LABEL, IDLE_MIN: '0', MAX_WAIT_MIN: '0', WAIT_S: '2' };
// Never the real launchctl: it would restart production.
assert.equal(execFileSync('sh', ['-c', 'command -v launchctl'], { env, encoding: 'utf8' }).trim(), path.join(BIN, 'launchctl'));

beforeEach(() => {
  for (const d of ['dist', 'dist.prev', 'dist.new']) fs.rmSync(path.join(REPO, d), { recursive: true, force: true });
  fs.cpSync(OLD, path.join(REPO, 'dist'), { recursive: true });
  fs.rmSync(CALLS, { force: true });
});

async function deploySafe(build: string): Promise<{ code: number; out: string }> {
  try { const r = await run('sh', [path.join(REPO, 'scripts/deploy-safe.sh')], { env: { ...env, FAKE_BUILD: build } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
}
const serving = (d = 'dist') => fs.readFileSync(path.join(REPO, d, 'server/index.js'), 'utf8');
const dists = () => fs.readdirSync(REPO).filter((f) => f.startsWith('dist')).sort();
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n') : []);
/** What deploy-safe must leave behind either way: its lock dropped and its throwaway worktree gone. */
function cleanedUp() {
  assert.equal(fs.existsSync(path.join(REPO, '.git/kino-deploy-safe.lock')), false, 'deploy lock released');
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1, 'build worktree removed');
}

test('deploy-safe: a build that fails verify-build is refused, dist/ untouched, launchctl never called', async () => {
  const r = await deploySafe(BROKEN);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fails its checks, nothing shipped, service untouched/);
  assert.match(r.out, /sw\.js pre-caches \/assets\/Player-c3\.js, which the build does not have/);
  assert.equal(serving(), '// old\n');
  assert.deepEqual(dists(), ['dist']);
  assert.deepEqual(calls(), []);
  cleanedUp();
});

test('deploy-safe: a build that passes is swapped in, the old one kept in dist.prev, and the service restarted', async () => {
  const r = await deploySafe(GOOD);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^deployed [0-9a-f]+ after 0 min idle wait$/m);
  assert.equal(serving(), '// good\n');
  assert.equal(serving('dist.prev'), '// old\n');
  assert.deepEqual(dists(), ['dist', 'dist.prev']);
  const svc = `gui/${process.getuid!()}/${LABEL}`;
  assert.deepEqual(calls(), [`print ${svc}`, `kickstart -k ${svc}`]);
  assert.match(fs.readFileSync(path.join(HOME, 'Library/Logs/kino/deploy-safe.log'), 'utf8'), /^entry chunk: .*\nsw\.js: every file it pre-caches is in the build$/m);
  cleanedUp();
});
