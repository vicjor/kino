import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageBar } from '../client/lib/storage.ts';

const GB = 1024 ** 3;

test('storageBar: no downloads, the bar and words as before', () => {
  assert.deepEqual(storageBar({ cacheBytes: 4 * GB, cacheCapBytes: 10 * GB, downloadBytes: 0 }), { saved: 0, cached: 40, used: '4.0 GB of 10 GB cache used', savedLine: undefined });
  assert.deepEqual(storageBar({ cacheBytes: 4 * GB, cacheCapBytes: 10 * GB }), storageBar({ cacheBytes: 4 * GB, cacheCapBytes: 10 * GB, downloadBytes: 0 }), 'an older server without downloadBytes');
  assert.deepEqual(storageBar({ cacheBytes: 0, cacheCapBytes: 10 * GB }), { saved: 0, cached: 0, used: '0 MB of 10 GB cache used', savedLine: undefined });
});

test('storageBar: downloads within the limit get their own segment and line, the total still counts them', () => {
  assert.deepEqual(storageBar({ cacheBytes: 9 * GB, cacheCapBytes: 10 * GB, downloadBytes: 4 * GB }), {
    saved: 40, cached: 50, used: '9.0 GB of 10 GB cache used', savedLine: 'Saved for later: 4.0 GB, kept when you clear the cache',
  });
});

test('storageBar: downloads alone past the limit fill the bar, never past 100%, and say so in words', () => {
  const b = storageBar({ cacheBytes: 15 * GB, cacheCapBytes: 10 * GB, downloadBytes: 14 * GB });
  assert.equal(b.savedLine, 'Saved for later: 14 GB, beyond the 10 GB cache limit');
  assert.equal(b.used, 'Other cached data: 1.0 GB');
  assert.equal(b.saved, 93.3);
  assert.equal(b.cached, 6.7);
  assert.ok(b.saved + b.cached <= 100);
  assert.equal(storageBar({ cacheBytes: 14 * GB, cacheCapBytes: 10 * GB, downloadBytes: 14 * GB }).used, 'Other cached data: none');
});

test('storageBar: a playing title past the limit spans the bar too; odd numbers stay in range', () => {
  assert.deepEqual(storageBar({ cacheBytes: 12 * GB, cacheCapBytes: 10 * GB, downloadBytes: 2 * GB }), {
    saved: 16.7, cached: 83.3, used: '12 GB of 10 GB cache used', savedLine: 'Saved for later: 2.0 GB, kept when you clear the cache',
  });
  const odd = storageBar({ cacheBytes: 3, cacheCapBytes: 0, downloadBytes: 9 });   // stale bytes: more downloads than cache
  assert.equal(odd.saved, 100);
  assert.equal(odd.cached, 0);
  for (const x of [odd, storageBar({ cacheBytes: -1, cacheCapBytes: -1, downloadBytes: -1 })]) {
    for (const n of [x.saved, x.cached]) assert.ok(n >= 0 && n <= 100, String(n));
  }
});
