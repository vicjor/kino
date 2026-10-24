import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrongCpuBinary, notMac } from './wrong-cpu.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
process.env.LOG_LEVEL = 'error';
const RETRY_MS = 60_000;
const { candidates, pickRunnable, pickRunnableAsync, pickCache, binRetry, binChecks, whyNotRun, errCode, isSpawnError, startFailure, runs, runsAsync, BinError, binStatus, binPath } = await import('../server/media/bins.ts');
type Picked = NonNullable<ReturnType<typeof pickRunnable>>;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const env = { path: '/custom/ffprobe', from: 'env' } as const;
const bundled = { path: '/nm/ffprobe-static/bin/darwin/arm64/ffprobe', from: 'static' } as const;
const brew = { path: '/opt/homebrew/bin/ffprobe', from: 'homebrew' } as const;
const onPath = { path: 'ffprobe', from: 'PATH' } as const;

test('candidates: override, bundled, Homebrew, /usr/local, MacPorts, PATH; no duplicates', () => {
  assert.deepEqual(candidates('ffprobe', '/custom/ffprobe', '/nm/ffprobe').map((c) => c.from), ['env', 'static', 'homebrew', 'usr-local', 'macports', 'PATH']);
  assert.deepEqual(candidates('ffmpeg', undefined, null).map((c) => c.path), ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', 'ffmpeg']);
  assert.deepEqual(candidates('ffprobe', '/opt/homebrew/bin/ffprobe', undefined).map((c) => c.from), ['env', 'usr-local', 'macports', 'PATH']);
  // An app opened from Finder has no MacPorts PATH: its binary is still found by full path, before a bare name.
  assert.deepEqual(pickRunnable(candidates('ffmpeg', undefined, '/nm/ffmpeg'), (p) => p === '/opt/local/bin/ffmpeg' || p === 'ffmpeg' || 'not found'), { path: '/opt/local/bin/ffmpeg', from: 'macports', ok: true });
  assert.equal(candidates('ffprobe', undefined, '/App.app/Contents/Resources/app.asar/node_modules/ffprobe')[0].path, '/App.app/Contents/Resources/app.asar.unpacked/node_modules/ffprobe');
});

test('pickRunnable: the override wins, even over a bundled binary that runs', () => {
  assert.deepEqual(pickRunnable([env, bundled, brew], () => true), { ...env, ok: true });
});

test('pickRunnable: an override that does not run is still used, flagged', () => {
  const tried: string[] = [];
  const p = pickRunnable([env, bundled, brew], (x) => { tried.push(x); return x === env.path ? 'not found' : true; });
  assert.deepEqual(p, { ...env, ok: false, why: 'not found' });
  assert.deepEqual(tried, [env.path], 'nothing past the override is tried');
  assert.equal(pickRunnable([env, brew], () => false)?.why, 'does not run');
});

test('pickRunnable: falls through a bundled binary for the wrong CPU, stops at the first that runs', () => {
  const tried: string[] = [];
  const p = pickRunnable([bundled, brew, onPath], (x) => { tried.push(x); return x === bundled.path ? 'bad CPU type' : true; });
  assert.deepEqual(p, { ...brew, ok: true });
  assert.deepEqual(tried, [bundled.path, brew.path]);
});

test('pickRunnable: undefined when nothing runs', () => {
  assert.equal(pickRunnable([bundled, brew, onPath], () => false), undefined);
  assert.equal(pickRunnable([], () => true), undefined);
});

// Shapes as Node 26 hands them out on macOS.
const badArch = Object.assign(new Error('spawn Unknown system error -86'), { errno: -86, code: 'Unknown system error -86', syscall: 'spawn' });
const missing = Object.assign(new Error('spawn /nope ENOENT'), { errno: -2, code: 'ENOENT', syscall: 'spawn /nope' });
const noExec = Object.assign(new Error('spawn /etc/hosts EACCES'), { errno: -13, code: 'EACCES', syscall: 'spawn /etc/hosts' });
const syncTimeout = Object.assign(new Error('spawnSync sleep ETIMEDOUT'), { errno: -60, code: 'ETIMEDOUT', syscall: 'spawnSync sleep' });
const exited = Object.assign(new Error('Command failed: ffprobe'), { code: 1, status: 1 });
const killed = Object.assign(new Error('Command failed: ffprobe'), { code: null, killed: true, signal: 'SIGKILL' });

test('whyNotRun: words for the log and the player', () => {
  assert.equal(errCode(badArch), 'EBADARCH');
  assert.equal(whyNotRun(badArch), 'bad CPU type');
  assert.equal(whyNotRun(missing), 'not found');
  assert.equal(whyNotRun(noExec), 'not executable');
  assert.equal(whyNotRun(syncTimeout), 'timed out');
  assert.equal(whyNotRun(exited), 'exited with code 1');
  assert.equal(whyNotRun(killed), 'killed (SIGKILL)');
  assert.equal(whyNotRun(new Error('odd')), 'odd');
});

test('isSpawnError: the program never started, a timeout or bad exit is something else', () => {
  assert.ok(isSpawnError(badArch));
  assert.ok(isSpawnError(missing));
  assert.ok(isSpawnError(noExec));
  assert.ok(!isSpawnError(syncTimeout));
  assert.ok(!isSpawnError(exited));
  assert.ok(!isSpawnError(killed));
  assert.ok(!isSpawnError(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })));
  assert.ok(!isSpawnError(undefined));
});

test('startFailure and BinError copy', () => {
  assert.equal(startFailure('ffmpeg', missing), 'ffmpeg could not start: ENOENT (not found)');
  assert.equal(startFailure('ffmpeg', badArch), 'ffmpeg could not start: EBADARCH (bad CPU type)');
  assert.equal(startFailure('ffmpeg', new Error('odd')), 'ffmpeg could not start: odd');
  const e = new BinError('ffprobe', '/x/ffprobe', 'bad CPU type');
  assert.match(e.message, /^Kino could not run ffprobe on this (Mac|computer) \(bad CPU type\)\. See the server log\.$/);
  assert.doesNotMatch(e.message, /torrent/i);
});

test('runs: real spawns, with the reason when it does not', () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'bins-'));
  const ok = path.join(tmp, 'ok'); fs.writeFileSync(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const bad = path.join(tmp, 'bad'); fs.writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const plain = path.join(tmp, 'plain'); fs.writeFileSync(plain, 'not a program', { mode: 0o644 });
  assert.equal(runs(ok), true);
  assert.equal(runs(bad), 'exited with code 3');
  assert.equal(runs(plain), 'not executable');
  assert.equal(runs(path.join(tmp, 'none')), 'not found');
});

test('runsAsync: the same answers as runs, without blocking', async () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'bins-'));
  const ok = path.join(tmp, 'ok'); fs.writeFileSync(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const bad = path.join(tmp, 'bad'); fs.writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const plain = path.join(tmp, 'plain'); fs.writeFileSync(plain, 'not a program', { mode: 0o644 });
  const hang = path.join(tmp, 'hang'); fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
  assert.equal(await runsAsync(ok), true);
  assert.equal(await runsAsync(bad), 'exited with code 3');
  assert.equal(await runsAsync(plain), 'not executable');
  assert.equal(await runsAsync(path.join(tmp, 'none')), 'not found');
  let ticks = 0; const t = setInterval(() => ticks++, 5);
  assert.equal(await runsAsync(hang, 50), 'timed out');
  clearInterval(t);
  assert.ok(ticks > 0, 'the event loop ran while it waited (a blocking spawn ticks 0 times)');
});

test('runs: a binary for another CPU is "bad CPU type", and resolution falls through it', { skip: notMac }, async () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'bins-'));
  const wrong = wrongCpuBinary(tmp);
  const ok = path.join(tmp, 'ok'); fs.writeFileSync(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(runs(wrong), 'bad CPU type');
  assert.equal(await runsAsync(wrong), 'bad CPU type', 'thrown, not called back: still an answer');
  const p = pickRunnable([{ path: wrong, from: 'static' }, { path: ok, from: 'homebrew' }], runs);
  assert.deepEqual(p, { path: ok, from: 'homebrew', ok: true });
  assert.deepEqual(await pickRunnableAsync([{ path: wrong, from: 'static' }, { path: ok, from: 'homebrew' }], runsAsync), { path: ok, from: 'homebrew', ok: true });
});

test('binStatus checks an override, binPath uses it as given, both read it at call time', () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'bins-'));
  const ok = path.join(tmp, 'ffprobe'); fs.writeFileSync(ok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const before = process.env.FFPROBE_BIN;
  try {
    process.env.FFPROBE_BIN = ok;
    assert.deepEqual(binStatus('ffprobe'), { ok: true, path: ok, from: 'env', checking: false });
    process.env.FFPROBE_BIN = path.join(tmp, 'missing');
    assert.equal(binPath('ffprobe'), path.join(tmp, 'missing'));
    assert.deepEqual(binStatus('ffprobe'), { ok: false, path: path.join(tmp, 'missing'), from: 'env', checking: false });
  } finally { if (before === undefined) delete process.env.FFPROBE_BIN; else process.env.FFPROBE_BIN = before; }
});

/**
 * A pickCache over pickRunnable with the ffprobe candidates, a fake clock and a fake set of binaries that run.
 * The re-check answers when `gate` lets it (at once by default), so a test can hold it in flight.
 */
function fakeBins() {
  const clock = { t: 0 };
  const installed = new Set<string>();
  const looks: (Picked | null | undefined)[] = [];
  const gate = { wait: Promise.resolve() };
  const pick = (name: 'ffmpeg' | 'ffprobe', env: string | undefined) => pickRunnable(candidates(name, env, bundled.path), (p) => installed.has(p) || 'not found') ?? null;
  const cache = pickCache(
    (name, env, before) => { looks.push(before); return pick(name, env); },
    async (name, env, before) => { looks.push(before); await gate.wait; return pick(name, env); },
    () => clock.t, { ms: RETRY_MS },
  );
  return { clock, installed, looks, gate, cache };
}

test('pickCache: nothing runs at boot, a later install is picked up within a minute, no restart', async () => {
  const { clock, installed, looks, cache } = fakeBins();
  assert.equal(cache.get('ffprobe', undefined), null);
  installed.add(brew.path);   // brew install ffmpeg
  clock.t = RETRY_MS - 1;
  assert.equal(cache.get('ffprobe', undefined), null, 'not looked up again within the minute');
  assert.equal(looks.length, 1);
  clock.t = RETRY_MS;
  assert.equal(cache.get('ffprobe', undefined), null, 'the minute is up: the cached pick now, the check in the background');
  await cache.settled();
  assert.deepEqual(cache.get('ffprobe', undefined), { ...brew, ok: true });
  assert.deepEqual(looks, [undefined, null], 'the re-check knows what it replaces');
  clock.t = 10 * RETRY_MS;
  cache.get('ffprobe', undefined);
  assert.equal(looks.length, 2, 'a pick that runs stands');
});

test('pickCache: a slow re-check never holds up a get, and only one runs at a time', async () => {
  const { clock, installed, looks, gate, cache } = fakeBins();
  let open = () => {}; gate.wait = new Promise((r) => { open = r; });
  assert.equal(cache.get('ffmpeg', undefined), null);
  installed.add('/opt/homebrew/bin/ffmpeg');
  clock.t = 5 * RETRY_MS;
  assert.equal(cache.checking('ffmpeg', undefined), false, 'nothing asked yet: no check');
  for (let i = 0; i < 5; i++) assert.equal(cache.get('ffmpeg', undefined), null, 'answers from the cache while the check runs');
  assert.equal(looks.length, 2, 'one check in flight, not one per get');
  assert.equal(cache.checking('ffmpeg', undefined), true, 'the null is from before the check: say so');
  assert.equal(cache.checking('ffmpeg', '/x/ffmpeg'), false, 'an override is its own entry');
  assert.equal(cache.checking('ffprobe', undefined), false);
  open(); await cache.settled();
  assert.equal(cache.checking('ffmpeg', undefined), false);
  assert.deepEqual(cache.get('ffmpeg', undefined), { path: '/opt/homebrew/bin/ffmpeg', from: 'homebrew', ok: true });
  assert.equal(looks.length, 2);
});

test('pickCache: a pick that fails to start is checked again right away, then at most once a minute', async () => {
  const { clock, installed, looks, cache } = fakeBins();
  installed.add(bundled.path).add(brew.path);
  assert.deepEqual(cache.get('ffprobe', undefined), { ...bundled, ok: true });
  clock.t = 5 * RETRY_MS;
  installed.delete(bundled.path);
  cache.failed('ffprobe', '/some/other/ffprobe');
  assert.equal(cache.get('ffprobe', undefined)?.path, bundled.path, 'a failure from another path is not this pick');
  cache.failed('ffmpeg');
  assert.equal(cache.get('ffprobe', undefined)?.path, bundled.path, 'nor is one of the other binary');
  assert.equal(looks.length, 1);
  cache.failed('ffprobe', bundled.path);
  assert.equal(looks.length, 2, 'last lookup was minutes ago: the check starts with the failure, before any get');
  await cache.settled();
  assert.deepEqual(cache.get('ffprobe', undefined), { ...brew, ok: true });
  installed.delete(brew.path);
  clock.t += 1000;
  cache.failed('ffprobe');
  assert.equal(cache.get('ffprobe', undefined)?.path, brew.path, 'failed again within the minute: no check yet');
  assert.equal(looks.length, 2);
  clock.t += RETRY_MS;
  assert.equal(cache.get('ffprobe', undefined)?.path, brew.path, 'the minute is up: checked in the background');
  await cache.settled();
  assert.equal(cache.get('ffprobe', undefined), null);
  assert.equal(looks.length, 3);
});

test('pickCache: an override that does not run is checked again after a minute, apart from the plain pick', async () => {
  const { clock, installed, looks, cache } = fakeBins();
  installed.add(brew.path);
  assert.deepEqual(cache.get('ffprobe', env.path), { ...env, ok: false, why: 'not found' });
  assert.deepEqual(cache.get('ffprobe', undefined), { ...brew, ok: true }, 'its own entry');
  installed.add(env.path);
  clock.t = RETRY_MS;
  cache.get('ffprobe', env.path);
  await cache.settled();
  assert.deepEqual(cache.get('ffprobe', env.path), { ...env, ok: true });
  assert.equal(looks.length, 3);
});

test('pickCache: a re-check that throws keeps the pick and waits another minute', async () => {
  let calls = 0; const clock = { t: 0 };
  const cache = pickCache(() => null, async () => { calls++; throw new Error('boom'); }, () => clock.t, { ms: RETRY_MS });
  assert.equal(cache.get('ffprobe', undefined), null);
  clock.t = RETRY_MS;
  cache.get('ffprobe', undefined);
  assert.equal(cache.checking('ffprobe', undefined), true);
  await cache.settled();
  assert.equal(cache.checking('ffprobe', undefined), false, 'a check that throws is over too');
  cache.get('ffprobe', undefined);
  assert.equal(calls, 1, 'not again within the minute');
  clock.t = 2 * RETRY_MS;
  cache.get('ffprobe', undefined); await cache.settled();
  assert.equal(calls, 2);
});

test('startFailure and BinError mark the pick as failed, so it is checked again', async () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'bins-'));
  const bin = path.join(tmp, 'ffprobe');
  // With binRetry.ms 0 every binStatus of a pick that does not run sets off a check, so settle it first: a check still running
  // the script while it is rewritten could read either version and land after the next await (a busy machine).
  const works = async (yes: boolean) => { await binChecks(); fs.writeFileSync(bin, `#!/bin/sh\nexit ${yes ? 0 : 1}\n`, { mode: 0o755 }); };
  const before = { env: process.env.FFPROBE_BIN, ms: binRetry.ms };
  /** binStatus once the background check it sets off has finished. */
  const settledStatus = async () => { binStatus('ffprobe'); await binChecks(); return binStatus('ffprobe'); };
  try {
    process.env.FFPROBE_BIN = bin; binRetry.ms = 0;
    await works(true);
    assert.equal(binStatus('ffprobe').ok, true);
    await works(false);
    assert.equal(binStatus('ffprobe').ok, true, 'a pick that runs stands until it fails');
    assert.equal(new BinError('ffprobe', bin, 'exited with code 1').why, 'exited with code 1');
    assert.deepEqual(binStatus('ffprobe'), { ok: true, path: bin, from: 'env', checking: true }, 'the check runs in the background: no answer waits for it, and it says one runs');
    await binChecks();
    assert.equal(binStatus('ffprobe').ok, false, 'BinError: checked again');
    await works(true);
    assert.equal((await settledStatus()).ok, true);
    await works(false);
    startFailure('ffprobe', missing);
    await binChecks();
    assert.equal(binStatus('ffprobe').ok, false, 'startFailure: checked again');
  } finally {
    await binChecks();
    binRetry.ms = before.ms;
    if (before.env === undefined) delete process.env.FFPROBE_BIN; else process.env.FFPROBE_BIN = before.env;
  }
});
