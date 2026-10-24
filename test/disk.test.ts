import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const { DiskFullError, dirSize, dirSizeAsync, hlsBytes, HLS_BYTES_MS, freeBytes, guard } = await import('../server/disk.ts');   // after KINO_DATA: disk.ts loads config.ts
const { HLS_DIR } = await import('../server/config.ts');
const { getState } = await import('../server/store.ts');
const { jsonErrors } = await import('../server/errors.ts');   // it logs, and log.ts loads config.ts too

const app = express();
app.get('/api/disk', () => { throw new DiskFullError('Disk nearly full'); });
app.use(jsonErrors);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('a DiskFullError reaches the client as a 507 through the JSON error handler, with its code', async () => {
  const d = await fetch(`${base}/disk`);
  assert.equal(d.status, 507);
  assert.deepEqual(await d.json(), { error: 'Disk nearly full', code: 'disk-full' });
});

test('dirSize adds up every file in nested folders, and an empty or missing folder is 0', () => {
  const root = path.join(DIR, 'sized');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'top.bin'), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, 'a', 'mid.bin'), Buffer.alloc(2_000));
  fs.writeFileSync(path.join(root, 'a', 'b', 'deep.bin'), Buffer.alloc(30_000));
  assert.equal(dirSize(root), 32_100);
  assert.equal(dirSize(path.join(root, 'a')), 32_000);
  assert.equal(dirSize(path.join(root, 'empty')), 0);
  assert.equal(dirSize(path.join(root, 'missing')), 0);
});

test('dirSizeAsync: the same totals as dirSize, an empty or missing folder is 0', async () => {
  const root = path.join(DIR, 'sized-async');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'top.bin'), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, 'a', 'mid.bin'), Buffer.alloc(2_000));
  fs.writeFileSync(path.join(root, 'a', 'b', 'deep.bin'), Buffer.alloc(30_000));
  assert.equal(await dirSizeAsync(root), 32_100);
  assert.equal(await dirSizeAsync(root), dirSize(root));
  assert.equal(await dirSizeAsync(path.join(root, 'empty')), 0);
  assert.equal(await dirSizeAsync(path.join(root, 'missing')), 0);
});

test('dirSizeAsync: a session folder of many segments, never more than `limit` reads in flight', async (t) => {
  const root = path.join(DIR, 'hls-like');
  for (const s of ['s1', 's2', 's3']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, s, `seg${String(i).padStart(5, '0')}.ts`), Buffer.alloc(10 + i));
  }
  let inFlight = 0, most = 0;
  const counted = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    try { return await fn(...a); } finally { inFlight--; }
  };
  t.mock.method(fs.promises, 'stat', counted(fs.promises.stat.bind(fs.promises)));
  t.mock.method(fs.promises, 'readdir', counted(fs.promises.readdir.bind(fs.promises)));
  const want = 3 * (40 * 10 + (39 * 40) / 2);
  assert.equal(await dirSizeAsync(root, 4), want);
  assert.ok(most <= 4, `at most 4 in flight, saw ${most}`);
  assert.ok(most >= 2, `reads overlap, saw ${most}`);
  t.mock.restoreAll();
  assert.equal(dirSize(root), want);
});

test('hlsBytes: one walk at a time, its total reused for a few seconds, then walked again', async () => {
  fs.writeFileSync(path.join(HLS_DIR, 'seg00000.ts'), Buffer.alloc(1_000));
  const a = hlsBytes(); const b = hlsBytes();
  assert.equal(a, b, 'asked during a walk: the same walk');
  assert.equal(await a, 1_000);
  fs.writeFileSync(path.join(HLS_DIR, 'seg00001.ts'), Buffer.alloc(500));
  assert.equal(await hlsBytes(), 1_000, 'within HLS_BYTES_MS: the last total');
  assert.equal(await hlsBytes(Date.now() + HLS_BYTES_MS), 1_500, 'after it: walked again');
});

test('freeBytes reports the volume of the folder: free within total, both above zero', () => {
  const { free, total } = freeBytes(DIR);
  assert.ok(Number.isFinite(free) && free > 0, `free ${free}`);
  assert.ok(Number.isFinite(total) && total >= free, `total ${total}, free ${free}`);
  assert.equal(freeBytes().total, freeBytes(path.join(DIR, 'cache')).total, 'defaults to the cache folder (free moves as other apps write, total does not)');
});

test('guard throws a DiskFullError (507) when free space is below the setting, and passes at 0', (t) => {
  const s = getState().settings;
  const was = s.minFreeBytes;
  t.after(() => { s.minFreeBytes = was; });
  s.minFreeBytes = 0;
  assert.doesNotThrow(() => guard());
  s.minFreeBytes = Number.MAX_SAFE_INTEGER;   // far beyond any disk, so free space is always below it
  assert.throws(() => guard(), (e: unknown) => e instanceof DiskFullError && e.status === 507 && /Disk nearly full/.test(e.message) && /Clear the cache in Settings/.test(e.message));
});
