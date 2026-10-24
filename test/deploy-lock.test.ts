import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** scripts/deploy-lock.sh on a temp lock path: the one-deploy-at-a-time lock deploy-safe, deploy-local and rollback-local share. */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/deploy-lock.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-deploy-lock-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOCK = path.join(TMP, 'kino-deploy-safe.lock');
beforeEach(() => fs.rmSync(LOCK, { recursive: true, force: true }));

function lock(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('sh', [SCRIPT, ...args], { env: { PATH: process.env.PATH, KINO_DEPLOY_LOCK: LOCK, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const read = (f: string) => fs.readFileSync(path.join(LOCK, f), 'utf8').trim();
const ALIVE = String(process.pid);
/** A pid that just exited: what a crashed deploy leaves in the lock. */
const DEAD = String(spawnSync('sh', ['-c', 'exit 0']).pid);

test('deploy-lock take: a free lock is taken with the name and pid inside', () => {
  assert.equal(lock(['take', 'make deploy-safe', ALIVE]).code, 0);
  assert.equal(read('pid'), ALIVE);
  assert.equal(read('name'), 'make deploy-safe');
});

test('deploy-lock take: a live holder refuses the second deploy and says who to wait for', () => {
  lock(['take', 'make deploy-safe', ALIVE]);
  const safe = lock(['take', 'make deploy-local', '1']);
  assert.equal(safe.code, 1);
  assert.match(safe.out, new RegExp(`make deploy-safe is running \\(pid ${ALIVE}\\).*kill ${ALIVE}`));
  assert.equal(read('pid'), ALIVE);

  fs.writeFileSync(path.join(LOCK, 'name'), 'make deploy-local\n');
  const local = lock(['take', 'make deploy-safe', '1']);
  assert.equal(local.code, 1);
  assert.match(local.out, /make deploy-local is running .*Let it finish\.$/m);
  assert.doesNotMatch(local.out, /kill/);
});

test('deploy-lock take: a lock from before names, or with no pid yet, still refuses', () => {
  fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'pid'), `${ALIVE}\n`);
  assert.match(lock(['take', 'make deploy-local', '1']).out, /^make deploy-safe is running/);
  fs.rmSync(path.join(LOCK, 'pid'));
  const r = lock(['take', 'make deploy-local', '1']);
  assert.equal(r.code, 1);
  assert.match(r.out, /wrote no pid.*rm -rf/);
});

test('deploy-lock take: a lock whose pid is gone is stale, cleared and taken', () => {
  lock(['take', 'make deploy-local', DEAD]);
  const r = lock(['take', 'make deploy-safe', ALIVE]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`stale deploy lock left by make deploy-local \\(pid ${DEAD}\\)`));
  assert.equal(read('pid'), ALIVE);
  assert.equal(read('name'), 'make deploy-safe');
});

test('deploy-lock check: free, stale or our own passes; another live holder fails', () => {
  assert.equal(lock(['check']).code, 0);
  lock(['take', 'make deploy-safe', DEAD]);
  assert.equal(lock(['check']).code, 0);
  fs.rmSync(LOCK, { recursive: true });
  lock(['take', 'make deploy-safe', ALIVE]);
  const r = lock(['check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /make deploy-safe is running/);
  assert.equal(lock(['check'], { KINO_DEPLOY_LOCK_PID: ALIVE }).code, 0);
  assert.equal(lock(['check'], { KINO_DEPLOY_LOCK_PID: '1' }).code, 1);
});

test('deploy-lock drop: only the holder lets it go', () => {
  lock(['take', 'make deploy-safe', ALIVE]);
  lock(['drop', '1']);
  assert.equal(fs.existsSync(LOCK), true);
  lock(['drop', ALIVE]);
  assert.equal(fs.existsSync(LOCK), false);
});

test('deploy-lock run: holds the lock while the command runs, passes its check and exit code, then lets go', () => {
  const r = lock(['run', 'make deploy-local', 'sh', '-c', `cat "$KINO_DEPLOY_LOCK/name" "$KINO_DEPLOY_LOCK/pid"; echo "env $KINO_DEPLOY_LOCK_PID"; sh '${SCRIPT}' check && echo own-check-ok; exit 3`]);
  assert.equal(r.code, 3, r.out);
  const [name, pid, env, own] = r.out.trim().split('\n');
  assert.equal(name, 'make deploy-local');
  assert.equal(env, `env ${pid}`);
  assert.equal(own, 'own-check-ok');
  assert.equal(fs.existsSync(LOCK), false);
});

test('deploy-lock run: refuses without running the command while deploy-safe holds the lock', () => {
  lock(['take', 'make deploy-safe', ALIVE]);
  const r = lock(['run', 'make rollback-local', 'sh', '-c', 'echo ran']);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /ran/);
  assert.equal(read('pid'), ALIVE);
});

test('deploy-lock: bad arguments are a usage error', () => {
  for (const args of [[], ['take', 'x'], ['drop'], ['run', 'x'], ['nonsense']]) assert.equal(lock(args).code, 2, args.join(' '));
});
