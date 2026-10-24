import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { precached, missing, checkSw, SW_ASSETS_MARK as MARK, SW_SHELL_FILES } from '../scripts/check-sw.ts';
import { fakeClient, FAKE_ASSETS as ASSETS } from './fake-build.ts';

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../client/public/sw.js'), 'utf8');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-check-sw-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const build = (name: string, leave: string[] = []) => fakeClient(path.join(DIR, name), leave);

test('precached: the page, manifest, icons and every bundle of this build; nothing in dev', async () => {
  assert.deepEqual(await precached(SRC.replace(MARK, JSON.stringify(ASSETS))), [...SW_SHELL_FILES, ...ASSETS]);
  assert.deepEqual(await precached(SRC), []);
});

test('missing: "/" is index.html, a query string is not part of the file, another origin is never in the build', () => {
  const dir = build('resolve');
  assert.deepEqual(missing(dir, ['/', '/icon.svg?v=2', 'icon-180.png', '/icon-181.png', 'https://cdn.invalid/icon.svg']), ['/icon-181.png', 'https://cdn.invalid/icon.svg']);
  fs.rmSync(path.join(dir, 'index.html'));
  assert.deepEqual(missing(dir, ['/']), ['/']);
});

test('checkSw: a whole build passes, one missing bundle or a renamed icon fails it', async () => {
  assert.deepEqual(await checkSw(build('whole')), []);
  assert.deepEqual(await checkSw(build('no-bundle', ['/assets/Player-c3.js'])), ['sw.js pre-caches /assets/Player-c3.js, which the build does not have']);
  const renamed = build('renamed');
  fs.renameSync(path.join(renamed, 'icon-192.png'), path.join(renamed, 'icon-192x192.png'));
  assert.deepEqual(await checkSw(renamed), ['sw.js pre-caches /icon-192.png, which the build does not have']);
});

test('checkSw: no sw.js, or one the build did not fill in, fails too', async () => {
  const dir = build('dev-sw');
  fs.writeFileSync(path.join(dir, 'sw.js'), SRC);
  assert.match((await checkSw(dir)).join(), /pre-caches nothing/);
  fs.rmSync(path.join(dir, 'sw.js'));
  assert.match((await checkSw(dir)).join(), /no sw\.js/);
});
