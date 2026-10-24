import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * scripts/ffmpeg-dmg.sh in a scratch checkout, offline: curl and shasum are stubs on PATH. curl hands out a prepared
 * .tar.xz (a bare arm64 Mach-O ffmpeg and ffprobe, which file(1) names, or x86_64 ones with WRONG_CPU) and fails
 * anything else; shasum answers the sum the script pins, or a wrong one with BAD_SUM. Every call is logged.
 */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/ffmpeg-dmg.sh');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-ffmpeg-dmg-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const REPO = path.join(TMP, 'repo'), BIN = path.join(TMP, 'bin'), TARS = path.join(TMP, 'tars'), CALLS = path.join(TMP, 'calls.log');
const VERSION = SRC.match(/^VERSION=(\S+)$/m)![1];
/** Build name and pinned SHA-256, as the script has them. */
const NAME = SRC.match(/^name=(\w+)$/m)![1], SUM = SRC.match(/^sum=([0-9a-f]{64})$/m)![1];
assert.equal(NAME, 'macarm64', 'the Apple Silicon build');
const GPL = path.resolve(import.meta.dirname, '../licenses/gpl-3.0.txt');
for (const d of [path.join(REPO, 'scripts'), path.join(REPO, 'licenses'), BIN, TARS]) fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(SCRIPT, path.join(REPO, 'scripts/ffmpeg-dmg.sh'));
fs.copyFileSync(GPL, path.join(REPO, 'licenses/gpl-3.0.txt'));

/** A bare 64-bit Mach-O executable header for the CPU: enough for file(1) to say arm64 or x86_64. */
function machO(arch: string): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12);
  return b;
}
for (const arch of ['arm64', 'x64']) {
  const dir = path.join(TARS, arch);
  fs.mkdirSync(dir);
  for (const b of ['ffmpeg', 'ffprobe']) fs.writeFileSync(path.join(dir, b), machO(arch));
  fs.writeFileSync(path.join(dir, 'ffplay'), 'not packed');
  execFileSync('tar', ['-cJf', path.join(TARS, `${arch}.tar.xz`), '-C', dir, 'ffmpeg', 'ffprobe', 'ffplay']);
}

// curl -fsSL -o FILE URL. WRONG_CPU hands out an Intel build under the asked-for name.
fs.writeFileSync(path.join(BIN, 'curl'), `#!/bin/sh
echo "curl $*" >>"${CALLS}"
while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done
case $1 in
  *_portable_${NAME}-gpl.tar.xz) cpu=arm64 ;;
  *) exit 22 ;;
esac
[ -n "$WRONG_CPU" ] && cpu=x64
cp "${TARS}/$cpu.tar.xz" "$out"
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'shasum'), `#!/bin/sh
echo "shasum $*" >>"${CALLS}"
sum=${SUM}
[ -n "$BAD_SUM" ] && sum=${'0'.repeat(64)}
echo "$sum  $3"
`, { mode: 0o755 });

function run(env: Record<string, string> = {}) {
  const r = spawnSync('sh', [path.join(REPO, 'scripts/ffmpeg-dmg.sh')], { cwd: TMP, env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, TMPDIR: TMP, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const OUT = path.join(REPO, 'vendor/ffmpeg');
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n') : []);
/** The script's own temp folders, which it must remove however it ends. */
const leftovers = () => fs.readdirSync(TMP).filter((f) => f.startsWith('kino-ffmpeg.'));

beforeEach(() => { fs.rmSync(path.join(REPO, 'vendor'), { recursive: true, force: true }); fs.rmSync(CALLS, { force: true }); });

test('ffmpeg-dmg.sh: the pinned arm64 build in vendor/ffmpeg, with the GPL text and where the source is', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`ffmpeg: jellyfin-ffmpeg ${VERSION.replace(/\./g, '\\.')} in vendor/ffmpeg`));
  assert.deepEqual(fs.readdirSync(OUT).sort(), ['.version', 'COPYING.GPLv3', 'README.txt', 'ffmpeg', 'ffprobe'], 'ffmpeg and ffprobe only, no ffplay');
  for (const b of ['ffmpeg', 'ffprobe']) assert.deepEqual(fs.readFileSync(path.join(OUT, b)), machO('arm64'), b);
  assert.deepEqual(fs.readFileSync(path.join(OUT, 'COPYING.GPLv3')), fs.readFileSync(GPL), 'the GPL text kept in the repo');
  assert.equal(calls().filter((c) => c.startsWith('curl ')).length, 1, 'one download: the build, nothing from gnu.org');
  const readme = fs.readFileSync(path.join(OUT, 'README.txt'), 'utf8');
  assert.ok(readme.includes(`jellyfin-ffmpeg ${VERSION}`), readme);
  assert.ok(readme.includes(`Source: https://github.com/jellyfin/jellyfin-ffmpeg/tree/v${VERSION}`), readme);
  assert.equal(fs.readFileSync(path.join(OUT, '.version'), 'utf8').trim(), VERSION);
  const tar = `jellyfin-ffmpeg_${VERSION}_portable_${NAME}-gpl.tar.xz`;
  assert.ok(calls().some((c) => c.startsWith('curl ') && c.endsWith(`/releases/download/v${VERSION}/${tar}`)), calls().join('\n'));
  assert.deepEqual(leftovers(), []);
});

test('ffmpeg-dmg.sh: the version already in place is kept, nothing is downloaded', () => {
  assert.equal(run().code, 0);
  fs.rmSync(CALLS);
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already in vendor\/ffmpeg/);
  assert.deepEqual(calls(), []);
  fs.writeFileSync(path.join(OUT, '.version'), 'older\n');
  assert.equal(run().code, 0);
  assert.ok(calls().some((c) => c.startsWith('curl ')), 'another version is fetched again');
});

test('ffmpeg-dmg.sh: a checksum that does not match fails before anything is unpacked', () => {
  const r = run({ BAD_SUM: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /SHA-256 mismatch for jellyfin-ffmpeg_.*_macarm64-gpl\.tar\.xz/);
  assert.equal(fs.existsSync(OUT), false);
  assert.deepEqual(leftovers(), []);
});

test('ffmpeg-dmg.sh: an Intel binary fails the build and its folder is removed, so it is never packed', () => {
  const r = run({ WRONG_CPU: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /ffmpeg in .* is not arm64/);
  assert.equal(fs.existsSync(OUT), false);
  assert.deepEqual(leftovers(), []);
});

test('licenses/gpl-3.0.txt is gnu.org\'s GPL v3 text, unchanged', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(GPL)).digest('hex'), '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986');
});
