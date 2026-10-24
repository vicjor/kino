import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const { staleSubs, pruneSubs, readCached, cachePath, writeCached } = await import('../server/subs/cache.ts');
after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);

test('staleSubs picks cache files unused for longer than the limit, nothing else', () => {
  const files = [
    { name: 'fresh.vtt', mtimeMs: NOW - 5 * DAY },
    { name: 'edge.vtt', mtimeMs: NOW - 60 * DAY },         // exactly at the limit stays
    { name: 'old.vtt', mtimeMs: NOW - 61 * DAY },
    { name: 'ancient.vtt', mtimeMs: 0 },
    { name: 'notes.txt', mtimeMs: 0 },                       // not ours
  ];
  assert.deepEqual(staleSubs(files, NOW), ['old.vtt', 'ancient.vtt']);
  assert.deepEqual(staleSubs(files, NOW, 3), ['fresh.vtt', 'edge.vtt', 'old.vtt', 'ancient.vtt']);
  assert.deepEqual(staleSubs([], NOW), []);
});

test('staleSubs also clears an old temp file a crash left behind', () => {
  assert.deepEqual(staleSubs([{ name: 'x.vtt.1.ab.tmp', mtimeMs: NOW - 61 * DAY }, { name: 'y.vtt.2.cd.tmp', mtimeMs: NOW - DAY }], NOW), ['x.vtt.1.ab.tmp']);
});

test('pruneSubs deletes stale files, a cache hit keeps a file alive', async () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'subs-'));
  const old = new Date(NOW - 90 * DAY);
  const put = (name: string) => { const p = path.join(dir, name); fs.writeFileSync(p, 'WEBVTT\n\n'); fs.utimesSync(p, old, old); return p; };
  const stale = put('stale.vtt'); const watched = put('watched.vtt'); const other = put('keep.json');
  fs.mkdirSync(path.join(dir, 'sub.vtt'));   // a directory is never touched
  assert.equal(readCached(watched), 'WEBVTT\n\n');
  assert.ok(fs.statSync(watched).mtimeMs > NOW - DAY);
  assert.equal(await pruneSubs(Date.now(), 60, dir), 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(watched), true);
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.existsSync(path.join(dir, 'sub.vtt')), true);
  assert.equal(await pruneSubs(Date.now(), 60, path.join(dir, 'missing')), 0);
});

test('readCached: a miss or an empty file is undefined; cache files live in the subs dir', () => {
  assert.equal(readCached(path.join(DIR, 'nope.vtt')), undefined);
  const p = path.join(DIR, 'empty.vtt'); fs.writeFileSync(p, '');
  assert.equal(readCached(p), undefined);
  assert.equal(path.dirname(cachePath('abc')), path.join(DIR, 'subs'));
  assert.match(path.basename(cachePath('abc')), /^[0-9a-f]{40}\.vtt$/);
});

test('writeCached replaces the file whole and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'subs-'));
  const file = path.join(dir, 'a.vtt');
  writeCached(file, 'WEBVTT\n\nold\n');
  writeCached(file, 'WEBVTT\n\nnew\n');
  assert.equal(readCached(file), 'WEBVTT\n\nnew\n');
  assert.deepEqual(fs.readdirSync(dir), ['a.vtt']);
});

test('writeCached into a missing folder throws and leaves nothing', () => {
  const dir = path.join(DIR, 'nope');
  assert.throws(() => writeCached(path.join(dir, 'a.vtt'), 'WEBVTT\n'));
  assert.equal(fs.existsSync(dir), false);
});
