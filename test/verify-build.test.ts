import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyBuild, report } from '../scripts/verify-build.ts';
import { fakeClient } from './fake-build.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/verify-build.ts');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-verify-build-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const build = (name: string, leave: string[] = []) => fakeClient(path.join(DIR, name), leave);

test('verifyBuild: a whole build passes every check, the entry chunk size first', async () => {
  const { out, err } = report(await verifyBuild(build('whole')));
  assert.deepEqual(err, []);
  assert.equal(out.length, 2);
  assert.match(out[0], /^entry chunk: [\d.]+ kB js \(gzip [\d.]+ kB\) \+ [\d.]+ kB css \(gzip [\d.]+ kB\)$/);
  assert.equal(out[1], 'sw.js: every file it pre-caches is in the build');
});

test('verifyBuild: every check reports, so one failure does not hide another', async () => {
  const dir = build('two-wrong', ['/index.html', '/assets/Player-c3.js']);
  const { out, err } = report(await verifyBuild(dir));
  assert.deepEqual(out, []);
  assert.deepEqual(err, [
    'verify-build: phones would get a blank page:', `  no index.html in ${dir}`,
    "verify-build: every phone's service worker update would fail:",
    '  sw.js pre-caches /, which the build does not have',
    '  sw.js pre-caches /assets/Player-c3.js, which the build does not have',
  ]);
});

test('verifyBuild: an index.html without its entry script fails, even when sw.js is fine', async () => {
  const dir = build('no-entry');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>hello</p>\n');
  assert.deepEqual(report(await verifyBuild(dir)).err, ['verify-build: phones would get a blank page:', '  index.html loads no module script']);
});

test('node scripts/verify-build.ts: 0 on a whole build, 1 naming the missing file, 2 without a folder', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const ok = cli(build('cli-ok'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^entry chunk: .*\nsw\.js: every file it pre-caches is in the build\n$/);
  const bad = cli(build('cli-bad', ['/assets/index-b2.css']));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\/assets\/index-b2\.css, which the build does not have/);
  assert.equal(cli().status, 2);
});

test('build:check and make deploy-local run verify-build on their client build (deploy-safe: test/deploy-safe.test.ts)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['build:check'], /\bnode scripts\/verify-build\.ts "\$D\/client"$/);
  assert.match(fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8'), /^\tbun scripts\/verify-build\.ts dist\.new\/client \|\| /m);
});
