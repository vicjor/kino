import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Everything below lives in a throwaway data dir: remove() is an rm -rf.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DATA;
const store = await import('../server/store.ts');
const torrent = await import('../server/torrent.ts');
const { CACHE_DIR, ensureDirs } = await import('../server/config.ts');
ensureDirs();   // the data folders the server makes at boot
store.load(path.join(DATA, 'state.json'));
after(() => { store.flushSync(); fs.rmSync(DATA, { recursive: true, force: true }); });

const A = 'a'.repeat(40);
const B = '0123456789abcdef0123456789abcdef01234567';

test('isInfoHash: 40 lowercase hex only', () => {
  assert.ok(torrent.isInfoHash(A));
  assert.ok(torrent.isInfoHash(B));
  for (const bad of ['', '..', '../..', '../x', `${A}/..`, `../${A}`, A.slice(1), `${A}0`, A.toUpperCase(), 'g'.repeat(40), `${A.slice(1)}/`, null, undefined, 42, [A]]) {
    assert.equal(torrent.isInfoHash(bad), false, String(bad));
  }
});

test('infoHashOf: hex and base32 btih both come out as lowercase hex', () => {
  assert.equal(torrent.infoHashOf(B.toUpperCase()), B);
  assert.equal(torrent.infoHashOf(`magnet:?xt=urn:btih:${B.toUpperCase()}&dn=x`), B);
  assert.equal(torrent.infoHashOf('magnet:?xt=urn:btih:3WBFL3G4PSSV7MF37AJSHWDQMLNR63I4&dn=x'), 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c');
  assert.equal(torrent.base32ToHex('3wbfl3g4pssv7mf37ajshwdqmlnr63i4'), 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c');
  assert.equal(torrent.infoHashOf('../..'), undefined);
  assert.equal(torrent.infoHashOf(''), undefined);
});

test('remove refuses anything but a hash and deletes nothing', async () => {
  const sibling = path.join(DATA, 'x');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(DATA, 'keep.txt'), 'keep');
  for (const bad of ['../x', '..', '../', '.', '', `../x/${A}`, A.toUpperCase()]) {
    await assert.rejects(torrent.remove(bad), (e: Error & { status?: number }) => e.status === 400, bad);
  }
  assert.ok(fs.existsSync(path.join(sibling, 'keep.txt')));
  assert.ok(fs.existsSync(path.join(DATA, 'keep.txt')));
  assert.ok(fs.existsSync(CACHE_DIR));
});

test('remove deletes one cache dir and its index entry, the neighbour survives', async () => {
  for (const h of [A, B]) {
    fs.mkdirSync(path.join(CACHE_DIR, h), { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, h, 'f.mkv'), 'x');
    store.update((s) => { s.cacheIndex[h] = { infoHash: h, name: h, bytes: 1, lastUsed: 1 }; });
  }
  await torrent.remove(A);
  assert.ok(!fs.existsSync(path.join(CACHE_DIR, A)));
  assert.equal(store.getState().cacheIndex[A], undefined);
  assert.ok(fs.existsSync(path.join(CACHE_DIR, B, 'f.mkv')));
  assert.ok(store.getState().cacheIndex[B]);
  store.flushSync();
});

test('isKnown: only hashes Kino chose (cache index, downloads) may start a torrent from /api/file', () => {
  const C = 'c'.repeat(40); const D = 'd'.repeat(40);
  assert.equal(torrent.isKnown(C), false);
  store.update((s) => { s.cacheIndex[C] = { infoHash: C, name: 'cached', bytes: 1, lastUsed: 1 }; });   // what a restart keeps
  assert.equal(torrent.isKnown(C), true);
  assert.equal(torrent.isKnown(C.toUpperCase()), true);
  assert.equal(torrent.isKnown(D), false);
  store.update((s) => { s.downloads[`${D}:0`] = { key: `${D}:0`, infoHash: D, fileIdx: 0, type: 'movie', name: 'later', sizeBytes: 1, addedAt: 1, done: false }; });
  assert.equal(torrent.isKnown(D), true);
  for (const bad of ['../x', '..', '__proto__', 'constructor', '', `${C}/..`]) assert.equal(torrent.isKnown(bad), false, bad);
  store.flushSync();
});
