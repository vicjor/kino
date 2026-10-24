import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
interface Asset { name: string; url: string; size: number; sha256: string }
const rules = require('../desktop/update-rules.cjs') as {
  isNewer: (tag: unknown, current: unknown) => boolean;
  pickAsset: (assets: unknown, platform: string, arch: string) => Asset | null;
  appBundle: (execPath: string) => string;
  SWAP_SCRIPT: string;
};
const { isNewer, pickAsset, appBundle, SWAP_SCRIPT } = rules;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-desktop-update-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('isNewer: numeric per part, equal and older are not newer, junk never is', () => {
  assert.equal(isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true, 'numbers, not strings');
  assert.equal(isNewer('v1.0.0', '0.99.99'), true);
  assert.equal(isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(isNewer('v0.1.0', '0.2.0'), false);
  assert.equal(isNewer('nightly', '0.1.0'), false);
  assert.equal(isNewer('v0.2.0', ''), false);
  assert.equal(isNewer('0.2.0-beta.1', 'v0.1.9'), true, 'with or without v, a pre-release suffix ignored');
  for (const v of ['', 'latest', 'v1.2', null, undefined, 3]) assert.equal(isNewer(v, '0.0.0'), false, String(v));
});

const gh = (name: string, extra: Record<string, unknown> = {}) => ({ name, browser_download_url: `https://example.com/${name}`, size: 100, ...extra });
const RELEASE = [gh('Kino-0.2.0-arm64.dmg', { digest: `sha256:${'AB'.repeat(32)}` }), gh('Kino-0.2.0.AppImage'), gh('Kino-0.2.0-arm64.AppImage'), gh('Kino-0.2.0-arm64.dmg.blockmap')];

test('pickAsset: the arm64 DMG on an Apple Silicon Mac, with size and lower-case SHA-256', () => {
  assert.deepEqual(pickAsset(RELEASE, 'darwin', 'arm64'), { name: 'Kino-0.2.0-arm64.dmg', url: 'https://example.com/Kino-0.2.0-arm64.dmg', size: 100, sha256: 'ab'.repeat(32) });
});

test('pickAsset: the AppImage for the CPU on Linux, no checksum when GitHub gives none', () => {
  assert.equal(pickAsset(RELEASE, 'linux', 'x64')?.name, 'Kino-0.2.0.AppImage');
  assert.equal(pickAsset(RELEASE, 'linux', 'x64')?.sha256, '');
  assert.equal(pickAsset(RELEASE, 'linux', 'arm64')?.name, 'Kino-0.2.0-arm64.AppImage');
});

test('pickAsset: nothing for an Intel Mac, Windows, a release without the file, or junk', () => {
  assert.equal(pickAsset(RELEASE, 'darwin', 'x64'), null, 'no Intel build');
  assert.equal(pickAsset(RELEASE, 'win32', 'x64'), null);
  assert.equal(pickAsset([gh('Kino-0.2.0.AppImage')], 'darwin', 'arm64'), null);
  assert.equal(pickAsset([gh('Kino-0.2.0-x64.dmg')], 'darwin', 'arm64'), null, 'an Intel DMG is never installed on Apple Silicon');
  for (const junk of [null, undefined, 'x', [null, { name: 1 }, { name: 'Kino-0.2.0-arm64.dmg' }]]) assert.equal(pickAsset(junk, 'darwin', 'arm64'), null);
});

test('appBundle: the .app around the binary, nothing for a translocated copy or no bundle', () => {
  assert.equal(appBundle('/Applications/Kino.app/Contents/MacOS/Kino'), '/Applications/Kino.app');
  assert.equal(appBundle('/Users/someone/Apps/Kino.app/Contents/MacOS/Kino'), '/Users/someone/Apps/Kino.app');
  assert.equal(appBundle('/private/var/folders/x/AppTranslocation/ABC/d/Kino.app/Contents/MacOS/Kino'), '');
  assert.equal(appBundle('/usr/lib/electron/electron'), '');
  assert.equal(appBundle('/Applications/Kino.app/Contents/Frameworks/Helper'), '');
});

/** An installed and a staged Kino.app in a work folder, and an `open` stub on PATH that logs what it opened. */
function scene(name: string) {
  const root = path.join(TMP, name), bin = path.join(root, 'bin'), dir = path.join(root, 'work');
  const appPath = path.join(root, 'Applications/Kino.app'), staged = path.join(dir, 'Kino.app'), opened = path.join(root, 'opened');
  for (const [d, v] of [[appPath, 'old'], [staged, 'new']]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'version'), v); }
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" >> "${opened}"\n`, { mode: 0o755 });
  const swap = (pid: number) => spawnSync('sh', ['-c', SWAP_SCRIPT, 'kino-update', String(pid), appPath, staged, dir], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  return { appPath, dir, opened, swap };
}

test('SWAP_SCRIPT: once the app has quit, the new one replaces it, the work folder goes, and it opens', async () => {
  const s = scene('swap');
  const child = spawn('sh', ['-c', 'exit 0']);
  await new Promise((r) => child.on('exit', r));
  const r = s.swap(child.pid!);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.appPath, 'version'), 'utf8'), 'new');
  assert.equal(fs.existsSync(s.dir), false);
  assert.equal(fs.readFileSync(s.opened, 'utf8').trim(), s.appPath);
});

test('SWAP_SCRIPT: waits for the app to exit before touching it', async () => {
  const s = scene('wait');
  const child = spawn('sleep', ['0.5']);
  const t = Date.now();
  const r = await new Promise<number | null>((resolve) => spawn('sh', ['-c', SWAP_SCRIPT, 'kino-update', String(child.pid), s.appPath, path.join(s.dir, 'Kino.app'), s.dir], { env: { ...process.env, PATH: `${path.join(TMP, 'wait/bin')}:${process.env.PATH}` } }).on('exit', resolve));
  assert.equal(r, 0);
  assert.ok(Date.now() - t >= 400, 'it waited');
  assert.equal(fs.readFileSync(path.join(s.appPath, 'version'), 'utf8'), 'new');
});

test('SWAP_SCRIPT: a staged app that is missing leaves the installed one in place and still opens it', async () => {
  const s = scene('missing');
  fs.rmSync(path.join(s.dir, 'Kino.app'), { recursive: true });
  const child = spawn('sh', ['-c', 'exit 0']);
  await new Promise((r) => child.on('exit', r));
  s.swap(child.pid!);
  assert.equal(fs.readFileSync(path.join(s.appPath, 'version'), 'utf8'), 'old');
  assert.equal(fs.existsSync(s.dir), false);
  assert.equal(fs.readFileSync(s.opened, 'utf8').trim(), s.appPath);
});
