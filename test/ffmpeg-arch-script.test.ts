import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * scripts/ffmpeg-arch.sh in a scratch checkout, offline: curl and shasum are stubs on PATH. curl hands out a prepared
 * .tar.xz per build name (a bare Mach-O ffmpeg and ffprobe for that CPU, which file(1) names) and a licence text;
 * shasum answers the sum the script pins for that build, or a wrong one with BAD_SUM. Every call is logged.
 */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/ffmpeg-arch.sh');
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-ffmpeg-arch-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const REPO = path.join(TMP, 'repo'), BIN = path.join(TMP, 'bin'), TARS = path.join(TMP, 'tars'), CALLS = path.join(TMP, 'calls.log');
const VERSION = SRC.match(/^VERSION=(\S+)$/m)![1];
/** Build name and pinned SHA-256 per arch, as the script has them. */
const PIN = Object.fromEntries([...SRC.matchAll(/^\s*(arm64|x64)\) name=(\w+); sum=([0-9a-f]{64});/gm)].map((m) => [m[1], { name: m[2], sum: m[3] }]));
assert.deepEqual(Object.keys(PIN).sort(), ['arm64', 'x64'], 'the script pins one build per CPU');
for (const d of [path.join(REPO, 'scripts'), BIN, TARS]) fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(SCRIPT, path.join(REPO, 'scripts/ffmpeg-arch.sh'));

/** A bare 64-bit Mach-O executable header for the CPU: enough for file(1) to say arm64 or x86_64. */
function machO(arch: string): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12);
  return b;
}
for (const [arch, { name }] of Object.entries(PIN)) {
  const dir = path.join(TARS, name);
  fs.mkdirSync(dir);
  for (const b of ['ffmpeg', 'ffprobe']) fs.writeFileSync(path.join(dir, b), machO(arch));
  fs.writeFileSync(path.join(dir, 'ffplay'), 'not packed');
  execFileSync('tar', ['-cJf', path.join(TARS, `${name}.tar.xz`), '-C', dir, 'ffmpeg', 'ffprobe', 'ffplay']);
}

// curl -fsSL -o FILE URL. WRONG_CPU hands out the other CPU's build under the asked-for name.
fs.writeFileSync(path.join(BIN, 'curl'), `#!/bin/sh
echo "curl $*" >>"${CALLS}"
while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done
case $1 in
  *_portable_macarm64-gpl.tar.xz) name=macarm64; other=mac64 ;;
  *_portable_mac64-gpl.tar.xz) name=mac64; other=macarm64 ;;
  *) echo "GPL v3 text" >"$out"; exit 0 ;;
esac
[ -n "$WRONG_CPU" ] && name=$other
cp "${TARS}/$name.tar.xz" "$out"
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'shasum'), `#!/bin/sh
echo "shasum $*" >>"${CALLS}"
case $3 in
  *_macarm64-gpl.tar.xz) sum=${PIN.arm64.sum} ;;
  *_mac64-gpl.tar.xz) sum=${PIN.x64.sum} ;;
esac
[ -n "$BAD_SUM" ] && sum=${'0'.repeat(64)}
echo "$sum  $3"
`, { mode: 0o755 });

function run(arch: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', [path.join(REPO, 'scripts/ffmpeg-arch.sh'), arch], { cwd: TMP, env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, TMPDIR: TMP, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const out = (arch: string) => path.join(REPO, 'vendor/ffmpeg', arch);
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n') : []);
/** The script's own temp folders, which it must remove however it ends. */
const leftovers = () => fs.readdirSync(TMP).filter((f) => f.startsWith('kino-ffmpeg.'));

beforeEach(() => { fs.rmSync(path.join(REPO, 'vendor'), { recursive: true, force: true }); fs.rmSync(CALLS, { force: true }); });

test('ffmpeg-arch.sh: each CPU gets its pinned build in vendor/ffmpeg/<arch>, with the GPL text and where the source is', () => {
  for (const arch of ['arm64', 'x64']) {
    const r = run(arch);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`ffmpeg for ${arch}: jellyfin-ffmpeg ${VERSION.replace(/\./g, '\\.')} in vendor/ffmpeg/${arch}`));
    assert.deepEqual(fs.readdirSync(out(arch)).sort(), ['.version', 'COPYING.GPLv3', 'README.txt', 'ffmpeg', 'ffprobe'], 'ffmpeg and ffprobe only, no ffplay');
    for (const b of ['ffmpeg', 'ffprobe']) assert.deepEqual(fs.readFileSync(path.join(out(arch), b)), machO(arch), b);
    assert.equal(fs.readFileSync(path.join(out(arch), 'COPYING.GPLv3'), 'utf8'), 'GPL v3 text\n');
    const readme = fs.readFileSync(path.join(out(arch), 'README.txt'), 'utf8');
    assert.ok(readme.includes(`jellyfin-ffmpeg ${VERSION}`), readme);
    assert.ok(readme.includes(`Source: https://github.com/jellyfin/jellyfin-ffmpeg/tree/v${VERSION}`), readme);
    assert.equal(fs.readFileSync(path.join(out(arch), '.version'), 'utf8').trim(), VERSION);
    const tar = `jellyfin-ffmpeg_${VERSION}_portable_${PIN[arch].name}-gpl.tar.xz`;
    assert.ok(calls().some((c) => c.startsWith('curl ') && c.endsWith(`/releases/download/v${VERSION}/${tar}`)), calls().join('\n'));
  }
  assert.deepEqual(leftovers(), []);
});

test('ffmpeg-arch.sh: the version already in place is kept, nothing is downloaded', () => {
  assert.equal(run('arm64').code, 0);
  fs.rmSync(CALLS);
  const r = run('arm64');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already in vendor\/ffmpeg\/arm64/);
  assert.deepEqual(calls(), []);
  fs.writeFileSync(path.join(out('arm64'), '.version'), 'older\n');
  assert.equal(run('arm64').code, 0);
  assert.ok(calls().some((c) => c.startsWith('curl ')), 'another version is fetched again');
});

test('ffmpeg-arch.sh: a checksum that does not match fails before anything is unpacked', () => {
  const r = run('x64', { BAD_SUM: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /SHA-256 mismatch for jellyfin-ffmpeg_.*_mac64-gpl\.tar\.xz/);
  assert.equal(fs.existsSync(out('x64')), false);
  assert.equal(calls().filter((c) => c.startsWith('curl ')).length, 1, 'no licence fetched either');
  assert.deepEqual(leftovers(), []);
});

test('ffmpeg-arch.sh: a binary for another CPU fails the build and its folder is removed, so it is never packed', () => {
  const r = run('arm64', { WRONG_CPU: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /ffmpeg in .* is not arm64/);
  assert.equal(fs.existsSync(out('arm64')), false);
  assert.deepEqual(leftovers(), []);
});

test('ffmpeg-arch.sh: an unknown or missing arch is a usage error, nothing fetched', () => {
  for (const arch of ['ia32', '']) {
    const r = run(arch);
    assert.equal(r.code, 2, arch);
    assert.match(r.out, /usage: scripts\/ffmpeg-arch\.sh arm64 \| x64/);
  }
  assert.deepEqual(calls(), []);
});
