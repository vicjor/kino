import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** scripts/desktop.sh in a scratch repo and worktree, with bun, electron and electron-builder stubbed on PATH. */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/desktop.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-desktop-sh-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MAIN = path.join(TMP, 'main'), WT = path.join(TMP, 'wt'), BIN = path.join(TMP, 'bin');
const ENV = { PATH: `${BIN}:${process.env.PATH}`, HOME: TMP, TMPDIR: TMP, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env: ENV, stdio: 'pipe' });
fs.mkdirSync(MAIN); fs.mkdirSync(BIN);
git(MAIN, 'init', '-q', '-b', 'main');
git(MAIN, 'commit', '-q', '--allow-empty', '-m', 'init');
git(MAIN, 'worktree', 'add', '-q', '--detach', WT);
for (const dir of [MAIN, WT]) { fs.mkdirSync(path.join(dir, 'scripts')); fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/desktop.sh')); }
// Each stub prints its name, its arguments and the environment the app would start with.
for (const name of ['bun', 'electron', 'electron-builder']) {
  fs.writeFileSync(path.join(BIN, name), `#!/bin/sh
echo "${name} $* | PORT=$PORT KINO_DATA=$KINO_DATA exists=$([ -d "$KINO_DATA" ] && echo yes) KINO_LOG_FILE=$KINO_LOG_FILE KINO_HOSTNAME=$KINO_HOSTNAME KINO_PLAIN_PORT=$KINO_PLAIN_PORT KINO_USER_DATA=$KINO_USER_DATA app_exists=$([ -d "$KINO_USER_DATA" ] && echo yes)"
`, { mode: 0o755 });
}
// electron-builder also prints the ffmpeg it would pack for the arch it was given, and fails for the arch in FAIL_ARCH.
fs.writeFileSync(path.join(BIN, 'electron-builder'), `#!/bin/sh
case " $* " in *" --arm64 "*) a=arm64 ;; *" --x64 "*) a=x64 ;; esac
echo "electron-builder $* | ff=$(cat vendor/ffmpeg/$a/ffmpeg 2>/dev/null)"
case " $* " in *" --$FAIL_ARCH "*) exit 1 ;; esac
`, { mode: 0o755 });
// scripts/ffmpeg-arch.sh, stubbed: says so, and puts a marker for the arch where the real one unpacks its build.
fs.writeFileSync(path.join(WT, 'scripts/ffmpeg-arch.sh'), 'echo "ffmpeg-arch $1"; mkdir -p "vendor/ffmpeg/$1"; printf "fake-%s" "$1" > "vendor/ffmpeg/$1/ffmpeg"\n');
// scripts/native-arch.sh, stubbed: says which CPU's node-datachannel it puts in place.
fs.writeFileSync(path.join(WT, 'scripts/native-arch.sh'), 'echo "native-arch $1"\n');
/** This machine's CPU as the scripts name it: the node-datachannel desktop.sh puts back after packaging. */
const HERE = os.arch() === 'arm64' ? 'arm64' : 'x64';

function run(dir: string, mode: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', [path.join(dir, 'scripts/desktop.sh'), mode], { cwd: TMP, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** A launchd agent in the scratch HOME whose WorkingDirectory is `dir`, as scripts/plist.sh writes it. */
const AGENT = path.join(TMP, 'Library/LaunchAgents/com.kino.plist');
function servedFrom(dir: string): void {
  fs.mkdirSync(path.dirname(AGENT), { recursive: true });
  fs.writeFileSync(AGENT, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.kino</string><key>WorkingDirectory</key><string>${dir}</string></dict></plist>\n`);
}

test('desktop.sh: refuses in the checkout launchd serves, whose dist/ is what production serves', { skip: process.platform !== 'darwin' }, () => {
  servedFrom(MAIN);
  try {
    for (const mode of ['run', 'dist']) {
      const r = run(MAIN, mode);
      assert.equal(r.code, 1, mode);
      assert.match(r.out, /Refusing: launchd serves Kino from this checkout/);
      assert.doesNotMatch(r.out, /bun run build \|/);
    }
  } finally { fs.rmSync(AGENT); }
  assert.equal(run(WT, 'nonsense').code, 2);
});

test('desktop.sh: a checkout launchd does not serve, a fresh clone, just builds and runs', () => {
  assert.match(run(MAIN, 'run').out, /^electron \. \|/m, 'no launchd agent at all');
  servedFrom(path.join(TMP, 'elsewhere'));
  try {
    const r = run(MAIN, 'run');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^bun run build \|/m);
  } finally { fs.rmSync(AGENT); }
});

test('desktop.sh: DEPLOY=1 builds and runs in the checkout launchd serves anyway', { skip: process.platform !== 'darwin' }, () => {
  servedFrom(MAIN);
  const r = run(MAIN, 'run', { DEPLOY: '1' });
  fs.rmSync(AGENT);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^bun run build \|/m);
  assert.match(r.out, /^electron \. \|/m);
});

test('desktop.sh dist: refuses a symlinked node_modules, then packs one DMG per CPU, each after fetching that CPU\'s ffmpeg', () => {
  fs.mkdirSync(path.join(TMP, 'borrowed'));
  fs.symlinkSync(path.join(TMP, 'borrowed'), path.join(WT, 'node_modules'));
  const refused = run(WT, 'dist');
  assert.equal(refused.code, 1);
  assert.match(refused.out, /node_modules is a symlink .*bun install/);
  assert.doesNotMatch(refused.out, /bun run build \|/);
  assert.doesNotMatch(refused.out, /^(ffmpeg-arch|native-arch|electron-builder) /m);

  fs.unlinkSync(path.join(WT, 'node_modules'));
  fs.mkdirSync(path.join(WT, 'node_modules'));
  const r = run(WT, 'dist');
  assert.equal(r.code, 0, r.out);
  // Build first, then per CPU: its ffmpeg and node-datachannel, then its DMG. `dmg` named: without a target, --arm64 builds every
  // arch in mac.target. This machine's node-datachannel goes back at the end.
  assert.deepEqual(r.out.split('\n').filter((l) => /^(bun|ffmpeg-arch|native-arch|electron-builder|electron) /.test(l)).map((l) => l.replace(/^bun run build \|.*/, 'bun run build')), [
    'bun run build',
    'ffmpeg-arch arm64',
    'native-arch arm64',
    'electron-builder --mac dmg --arm64 --publish never | ff=fake-arm64',
    'ffmpeg-arch x64',
    'native-arch x64',
    'electron-builder --mac dmg --x64 --publish never | ff=fake-x64',
    `native-arch ${HERE}`,
  ], 'and no electron app started');

  const failed = run(WT, 'dist', { FAIL_ARCH: 'arm64' });
  assert.equal(failed.code, 1, failed.out);
  assert.doesNotMatch(failed.out, /ffmpeg-arch x64|--x64/, 'stops at the first failed build');
  assert.equal(failed.out.split('\n').filter((l) => l.startsWith('native-arch ')).at(-1), `native-arch ${HERE}`, 'and still puts this machine\'s node-datachannel back');
  fs.rmSync(path.join(WT, 'node_modules'), { recursive: true });
  fs.rmSync(path.join(WT, 'vendor'), { recursive: true });
});

/** The env line the electron stub printed. */
const appEnv = (out: string) => out.split('\n').find((l) => l.startsWith('electron . |')) ?? '';

/** The Electron folder (KINO_USER_DATA) the electron stub saw, and whether it existed then. */
const appDir = (line: string) => line.match(/ KINO_USER_DATA=(\S*) app_exists=(yes)?$/)?.slice(1) ?? [];

test('desktop.sh run in a worktree: its own server on :1299 with a throwaway data folder, never :1234', () => {
  const r = run(WT, 'run');
  assert.equal(r.code, 0, r.out);
  const line = appEnv(r.out);
  assert.match(line, /PORT=1299 /);
  assert.match(line, /KINO_HOSTNAME=off KINO_PLAIN_PORT=0 /);
  const data = line.match(/KINO_DATA=(\S+) exists=yes /)?.[1] ?? '';
  assert.ok(data.startsWith(path.join(TMP, 'kino-desktop.')), line);
  assert.ok(line.includes(`KINO_LOG_FILE=${data}/kino.log `), line);
  assert.equal(fs.existsSync(data), false, 'removed once the app quits');
});

test('desktop.sh run in a worktree: a throwaway Electron folder too, apart from Kino.app\'s and its single-instance lock', () => {
  const line = appEnv(run(WT, 'run').out);
  const [app, existed] = appDir(line);
  assert.ok(app?.startsWith(path.join(TMP, 'kino-desktop-app.')), line);
  assert.equal(existed, 'yes', line);
  assert.ok(!line.includes(`KINO_DATA=${app} `), 'not the data folder');
  assert.equal(fs.existsSync(app!), false, 'removed once the app quits');
});

test('desktop.sh run in a worktree: a given PORT, KINO_DATA and KINO_USER_DATA win, and those folders are kept', () => {
  const keep = path.join(TMP, 'keep'), keepApp = path.join(TMP, 'keep-app');
  fs.mkdirSync(keep); fs.mkdirSync(keepApp);
  const line = appEnv(run(WT, 'run', { PORT: '1288', KINO_DATA: keep }).out);
  assert.ok(line.includes(`PORT=1288 KINO_DATA=${keep} exists=yes KINO_LOG_FILE=${keep}/kino.log `), line);
  assert.equal(fs.existsSync(keep), true);
  const [made] = appDir(line);
  assert.ok(made?.startsWith(path.join(TMP, 'kino-desktop-app.')), line);
  assert.equal(fs.existsSync(made!), false, 'the Electron folder it made is still removed');

  const given = appEnv(run(WT, 'run', { KINO_DATA: keep, KINO_USER_DATA: keepApp }).out);
  assert.deepEqual(appDir(given), [keepApp, 'yes']);
  assert.equal(fs.existsSync(keep) && fs.existsSync(keepApp), true);
});

test('desktop.sh run with DEPLOY=1 in the main checkout leaves port and data to the app (:1234, its own folder)', () => {
  const line = appEnv(run(MAIN, 'run', { DEPLOY: '1' }).out);
  assert.match(line, /PORT= KINO_DATA= exists= /);
  assert.deepEqual(appDir(line), ['', undefined]);
});
