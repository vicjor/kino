import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * scripts/native-arch.sh in a scratch checkout whose node-datachannel has a stubbed prebuild-install: it logs its
 * arguments and writes a bare Mach-O for the CPU asked (or for WRONG_CPU), which file(1) names. No download.
 */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/native-arch.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-native-arch-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const REPO = path.join(TMP, 'repo'), NDC = path.join(REPO, 'node_modules/node-datachannel'), CALLS = path.join(TMP, 'calls.log');
const BIN = path.join(NDC, 'build/Release/node_datachannel.node');
fs.mkdirSync(path.join(REPO, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'node_modules/.bin'), { recursive: true });
fs.mkdirSync(NDC, { recursive: true });
fs.copyFileSync(SCRIPT, path.join(REPO, 'scripts/native-arch.sh'));

/** A bare 64-bit Mach-O header for the CPU: enough for file(1) to say arm64 or x86_64. */
const machO = (arch: string) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12); return b; };
fs.writeFileSync(path.join(TMP, 'arm64.bin'), machO('arm64'));
fs.writeFileSync(path.join(TMP, 'x64.bin'), machO('x64'));
fs.writeFileSync(path.join(REPO, 'node_modules/.bin/prebuild-install'), `#!/bin/sh
echo "prebuild-install $* (in $(basename "$PWD"))" >> "${CALLS}"
arch=; while [ $# -gt 0 ]; do [ "$1" = --arch ] && arch=$2; shift; done
mkdir -p build/Release && cp "${TMP}/\${WRONG_CPU:-$arch}.bin" build/Release/node_datachannel.node
`, { mode: 0o755 });

function run(arch: string, env: Record<string, string> = {}) {
  fs.rmSync(CALLS, { force: true });
  const r = spawnSync('sh', [path.join(REPO, 'scripts/native-arch.sh'), arch], { cwd: TMP, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, calls: fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n') : [] };
}

test('native-arch.sh: fetches the CPU asked for macOS when another is in place, and leaves a matching one alone', () => {
  fs.mkdirSync(path.dirname(BIN), { recursive: true }); fs.writeFileSync(BIN, machO('arm64'));
  const x = run('x64');
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(x.calls, ['prebuild-install -r napi --platform darwin --arch x64 (in node-datachannel)']);
  assert.match(x.out, /node-datachannel for x64: fetched/);
  const again = run('x64');
  assert.deepEqual([again.code, again.calls], [0, []], 'already in place: no fetch');
  assert.match(again.out, /in place/);
  assert.equal(run('arm64').calls.length, 1, 'and back');
});

test('native-arch.sh: a binary for another CPU fails, an unknown CPU is a usage error', () => {
  fs.writeFileSync(BIN, machO('arm64'));
  const r = run('x64', { WRONG_CPU: 'arm64' });
  assert.equal(r.code, 1);
  assert.match(r.out, /node-datachannel for x64: got /);
  for (const a of ['ia32', '']) { const u = run(a); assert.deepEqual([u.code, u.calls], [2, []], a); }
});
