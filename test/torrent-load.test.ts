import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type WebTorrent from 'webtorrent';
// A fake webtorrent client: nothing here ever joins a real swarm. Data lives in a throwaway dir.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DATA;
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const store = await import('../server/store.ts');
const torrent = await import('../server/torrent.ts');
const events = await import('../server/events.ts');
store.load(path.join(DATA, 'state.json'));
store.update((s) => { s.settings.minFreeBytes = 0; });

class FakeFile {
  selects = 0; deselects = 0; downloaded = 0; offset = 0; path: string;
  constructor(public name: string, public length = 1000) { this.path = name; }
  get progress() { return this.downloaded / this.length; }
  select() { this.selects++; }
  deselect() { this.deselects++; }
  createReadStream(): never { throw new Error('not in tests'); }
}
class FakeTorrent extends EventEmitter {
  files: FakeFile[] = []; destroyed = false; name = ''; numPeers = 3; downloadSpeed = 0; uploadSpeed = 0; progress = 0; downloaded = 0; length = 0; ready = false; magnetURI = '';
  constructor(public infoHash: string) { super(); }
  /** What webtorrent does once the swarm hands over the info dictionary. */
  meta(...names: string[]) { this.name = names[0]; this.files = names.map((n) => new FakeFile(n)); this.length = this.files.length * 1000; this.ready = true; this.emit('metadata'); }
  destroy(_o?: unknown, cb?: () => void) { this.destroyed = true; if (cb) setImmediate(cb); }   // async, like the real store close
}
const added: FakeTorrent[] = [];
const fake = { add: (magnet: string) => { const t = new FakeTorrent(torrent.infoHashOf(magnet)!); added.push(t); return t; }, destroy: (cb?: () => void) => cb?.() };
torrent.setClientForTests(fake as unknown as WebTorrent);

beforeEach(() => { added.length = 0; });
const H = (c: string) => c.repeat(40);
after(async () => {
  for (const c of '0123456789') await torrent.remove(H(c));   // a failed test must not leave a stats ticker running
  torrent.setClientForTests(null); store.flushSync(); fs.rmSync(DATA, { recursive: true, force: true });
});

test('ensure: a second caller during the metadata wait shares it and never sees a torrent with no files', async () => {
  const h = H('1');
  const a = torrent.ensure(h);
  const b = torrent.ensure(`magnet:?xt=urn:btih:${h}`);
  await Promise.resolve();
  assert.equal(added.length, 1, 'one add for both callers');
  assert.equal(torrent.getTorrent(h), undefined, 'getTorrent hides a torrent still loading');
  assert.equal(torrent.isKnown(h), true, 'a loading torrent is still known (so /api/file waits for it)');
  assert.equal(torrent.stats(h).numPeers, 3, 'peers show while metadata loads');
  added[0].meta('Show.S01E01.mkv', 'Show.S01E02.mkv');
  const [ta, tb] = await Promise.all([a, b]);
  assert.equal(ta, tb);
  assert.equal(ta.files.length, 2);
  assert.equal(torrent.getTorrent(h), ta);
  assert.equal(await torrent.ensure(h), ta, 'loaded: reused, no new add');
  assert.equal(added.length, 1);
  await torrent.remove(h);
});

test('ensure: no metadata in time is a 404 in words, which the player shows as it is', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const h = 'fe'.repeat(20);
  const p = torrent.ensure(h);
  await Promise.resolve();
  const w = process.stderr.write; process.stderr.write = (() => true) as typeof w;   // the timeout is logged as a warning
  try { ctx.mock.timers.tick(45_000); } finally { process.stderr.write = w; }
  await assert.rejects(p, (e: unknown) => (e as { status?: number }).status === 404 && /^No peers found for this torrent/.test((e as Error).message));
  assert.ok(added[0].destroyed);
});

test('ensure: remove during the metadata wait rejects every waiter and forgets the hash', async () => {
  const h = H('2');
  const a = torrent.ensure(h); const b = torrent.ensure(h);
  await Promise.resolve();
  await torrent.remove(h);
  await assert.rejects(a, /Removed/);
  await assert.rejects(b, /Removed/);
  assert.ok(added[0].destroyed);
  assert.equal(torrent.isKnown(h), false);
  assert.equal(torrent.getTorrent(h), undefined);
});

test('whenKnown: true the moment a play starts loading the hash, not at the cap; an unknown one is false after it', { timeout: 1000 }, async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const h = H('a'); const never = H('b'); const cached = H('c');
  let answer: boolean | undefined;
  const raced = torrent.whenKnown(h.toUpperCase(), 2000).then((v) => { answer = v; });
  const unknown = torrent.whenKnown(never, 2000);
  const indexed = torrent.whenKnown(cached, 2000);
  ctx.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(answer, undefined, 'still waiting');
  const play = torrent.ensure(h);   // POST /api/play, a moment after the subtitle request
  await raced;   // no timer moves: only the ensure() can wake it
  assert.equal(answer, true);
  store.update((s) => { s.cacheIndex[cached] = { infoHash: cached, name: cached, bytes: 1, lastUsed: Date.now() }; });
  ctx.mock.timers.tick(1500);
  assert.equal(await unknown, false, 'never loaded: false at the cap');
  assert.equal(await indexed, true, 'a cache index entry counts, checked at the cap');
  assert.equal(await torrent.whenKnown(h, 0), true, 'known: at once, even with no wait');
  assert.equal(await torrent.whenKnown(never, 0), false);
  assert.equal(await torrent.whenKnown('../x', 2000), false, 'not a hash: no wait at all');
  added[0].meta('Movie.mkv');
  await play;
  await torrent.remove(h); await torrent.remove(cached);
});

/** A loaded fake torrent with these files; every file starts deselected (ensure deselects them all once). */
async function loaded(h: string, ...names: string[]) {
  const p = torrent.ensure(h);
  await Promise.resolve();
  const ft = added.at(-1)!;
  ft.meta(...names);
  for (const f of ft.files) f.deselects = 0;
  return { t: await p, files: ft.files };
}

test('closeFile: a file nobody reads stops downloading after the grace period, the open neighbour keeps going', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const { t, files: [e1, e2, e3] } = await loaded(H('3'), 'Show.S01E01.mkv', 'Show.S01E02.mkv', 'Show.S01E03.mkv');
  torrent.openFile(t, 0); torrent.closeFile(t, 0);
  ctx.mock.timers.tick(torrent.DESELECT_GRACE_MS - 1);
  torrent.openFile(t, 0);   // the next range request, within the grace period
  ctx.mock.timers.tick(torrent.DESELECT_GRACE_MS);
  assert.equal(e1.deselects, 0, 'reopened in time: still selected');
  torrent.openFile(t, 1);   // auto-next
  torrent.closeFile(t, 0);
  ctx.mock.timers.tick(torrent.DESELECT_GRACE_MS);
  assert.equal(e1.deselects, 1, 'the finished episode stops downloading');
  assert.equal(e2.deselects, 0);
  assert.equal(e2.selects, 2, 'the open episode is selected again (a shared boundary piece)');
  assert.equal(e3.selects + e3.deselects, 0, 'never opened, never touched');
  torrent.closeFile(t, 1);
  await torrent.remove(t.infoHash);
});

test('closeFile: a download hold keeps the file selected, a complete file is left alone', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const { t, files: [a, b] } = await loaded(H('4'), 'Movie.mkv', 'Extra.mkv');
  torrent.openFile(t, 0);   // the download hold
  torrent.openFile(t, 0); torrent.closeFile(t, 0);   // a viewer comes and goes
  ctx.mock.timers.tick(torrent.DESELECT_GRACE_MS);
  assert.equal(a.deselects, 0);
  b.downloaded = b.length;
  torrent.openFile(t, 1); torrent.closeFile(t, 1);
  ctx.mock.timers.tick(torrent.DESELECT_GRACE_MS);
  assert.equal(b.deselects, 0, 'complete: nothing to stop');
  torrent.closeFile(t, 0);
  await torrent.remove(t.infoHash);
});

test('ensure: a torrent only looked at unloads after the idle time, an open file keeps it loaded', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const h = H('5');
  const { t: first } = await loaded(h, 'Movie.mkv');   // file list shown, nothing played
  ctx.mock.timers.tick(torrent.IDLE_MS);
  assert.equal(torrent.getTorrent(h), undefined, 'inspected only: unloaded');
  assert.ok(first.destroyed);
  const { t } = await loaded(h, 'Movie.mkv');
  ctx.mock.timers.tick(torrent.IDLE_MS - 1);
  assert.equal(await torrent.ensure(h), t, 'looked at again: the clock restarts');
  ctx.mock.timers.tick(torrent.IDLE_MS - 1);
  assert.equal(torrent.getTorrent(h), t);
  torrent.openFile(t, 0);
  ctx.mock.timers.tick(torrent.IDLE_MS);
  assert.equal(torrent.getTorrent(h), t, 'open: never unloads');
  torrent.closeFile(t, 0);
  ctx.mock.timers.tick(torrent.IDLE_MS);
  assert.equal(torrent.getTorrent(h), undefined);
  assert.ok(added.at(-1)!.destroyed);
  assert.ok(store.getState().cacheIndex[h], 'unloaded, still cached');
  await torrent.remove(h);
});

test('refreshSizes: bytes only, lastUsed stays, and no state write when nothing changed', async () => {
  const h = H('6');
  await loaded(h, 'Movie.mkv');
  store.update((s) => { s.cacheIndex[h].lastUsed = 1; });
  added.at(-1)!.downloaded = 500;
  torrent.refreshSizes();
  assert.deepEqual({ ...store.getState().cacheIndex[h] }, { infoHash: h, name: 'Movie.mkv', bytes: 500, lastUsed: 1 });
  store.flushSync();
  const file = path.join(DATA, 'state.json');
  fs.rmSync(file);
  torrent.refreshSizes();
  store.flushSync();
  assert.equal(fs.existsSync(file), false, 'unchanged: state.json not rewritten');
  await torrent.remove(h);
});

test('remove: drops refs and timers of an open torrent; a late closeFile from the old load changes nothing', async () => {
  const h = H('7');
  const { t } = await loaded(h, 'Movie.mkv');
  torrent.openFile(t, 0);
  await torrent.remove(h);
  assert.equal(torrent.isActive(h), false);
  assert.equal(torrent.openStreams(), 0);
  const { t: t2 } = await loaded(h, 'Movie.mkv');   // played again
  torrent.openFile(t2, 0);
  torrent.closeFile(t, 0);   // the old stream ends late
  assert.equal(torrent.isActive(h), true, 'the new load keeps its ref');
  torrent.closeFile(t2, 0);
  await torrent.remove(h);
});

test('activeTorrents: the client torrents, 0 with no client yet (it only reads, the first play creates the client)', () => {
  torrent.setClientForTests({ torrents: [{}, {}] } as unknown as WebTorrent);
  assert.equal(torrent.activeTorrents(), 2);
  torrent.setClientForTests(null);
  try { assert.equal(torrent.activeTorrents(), 0); }
  finally { torrent.setClientForTests(fake as unknown as WebTorrent); }
});

test('planEviction: least recently used first, kept ones skipped but counted, stops at the cap', () => {
  const e = (h: string, bytes: number, lastUsed: number) => ({ infoHash: h, name: h, bytes, lastUsed });
  const entries = [e('new', 40, 300), e('old', 30, 100), e('mid', 30, 200)];
  const none = () => false;
  assert.deepEqual(torrent.planEviction(entries, 100, none), []);
  assert.deepEqual(torrent.planEviction(entries, 70, none), ['old']);
  assert.deepEqual(torrent.planEviction(entries, 40, none), ['old', 'mid']);
  assert.deepEqual(torrent.planEviction(entries, 39, none), ['old', 'mid', 'new']);
  assert.deepEqual(torrent.planEviction(entries, 70, (h) => h === 'old'), ['mid']);
  assert.deepEqual(torrent.planEviction(entries, 0, (h) => h === 'new'), ['old', 'mid'], 'cannot reach the cap: active stays');
  assert.deepEqual(torrent.planEviction([], 0, none), []);
  assert.deepEqual(entries.map((x) => x.infoHash), ['new', 'old', 'mid'], 'input order untouched');
  const kept = new Set(['old', 'mid']);   // a playing one and a download for later
  assert.deepEqual(torrent.planEviction(entries, 1, (h) => kept.has(h)), ['new'], 'a 1 GB cap still spares every kept one');
});

test('evict: a finished download for later stays, whatever the cap; a plain cache entry goes', async () => {
  const d = H('a'), c = H('b');
  const cap = store.getState().settings.cacheCapBytes;
  store.update((s) => {
    s.settings.cacheCapBytes = 10;   // typing a lower cache limit
    s.cacheIndex[d] = { infoHash: d, name: 'Saved.mkv', bytes: 80, lastUsed: 1 };   // least recently used, nothing open
    s.cacheIndex[c] = { infoHash: c, name: 'Watched.mkv', bytes: 80, lastUsed: 2 };
    s.downloads[`${d}:0`] = { key: `${d}:0`, infoHash: d, fileIdx: 0, type: 'movie', name: 'Saved', sizeBytes: 80, addedAt: 1, done: true, doneAt: 2 };
  });
  assert.equal(torrent.isActive(d), false);
  assert.deepEqual(await torrent.evict(), [c]);
  assert.ok(store.getState().cacheIndex[d], 'the download is still in the cache');
  assert.equal(store.getState().cacheIndex[c], undefined);
  store.update((s) => { delete s.downloads[`${d}:0`]; s.settings.cacheCapBytes = cap; });
  await torrent.remove(d);
});

test('evict: calls at once run one after the other, nothing removed twice, a loading torrent is left alone', async () => {
  const h = H('8'); const g = H('9');
  const cap = store.getState().settings.cacheCapBytes;
  await loaded(h, 'Old.mkv');
  const loadingG = torrent.ensure(g);   // being played again right now
  await Promise.resolve();
  store.update((s) => {
    s.settings.cacheCapBytes = 100;
    s.cacheIndex[h] = { ...s.cacheIndex[h], bytes: 80, lastUsed: 2 };
    s.cacheIndex[g] = { infoHash: g, name: 'g', bytes: 80, lastUsed: 1 };
  });
  const [a, b] = await Promise.all([torrent.evict(), torrent.evict()]);
  assert.deepEqual(a, [h]);
  assert.deepEqual(b, [], 'the second run sees the first one done');
  assert.equal(store.getState().cacheIndex[h], undefined);
  assert.ok(store.getState().cacheIndex[g]);
  added.at(-1)!.meta('g.mkv');
  await loadingG;
  await torrent.remove(g);
  store.update((s) => { s.settings.cacheCapBytes = cap; });
});

test('openFile: a seek within a minute of the last use writes no state, an older use is bumped', async () => {
  const h = H('0');
  const { t } = await loaded(h, 'Movie.mkv');
  const file = path.join(DATA, 'state.json');
  const written = (fn: () => void) => { store.flushSync(); fs.rmSync(file, { force: true }); fn(); store.flushSync(); return fs.existsSync(file); };
  torrent.openFile(t, 0); torrent.closeFile(t, 0);
  const used = store.getState().cacheIndex[h].lastUsed;
  assert.equal(written(() => { torrent.openFile(t, 0); torrent.closeFile(t, 0); }), false, 'a seek: lastUsed is fresh, state.json untouched');
  assert.equal(store.getState().cacheIndex[h].lastUsed, used);
  store.update((s) => { s.cacheIndex[h].lastUsed = Date.now() - torrent.USED_RESOLUTION_MS - 1; });
  assert.equal(written(() => torrent.openFile(t, 0)), true, 'over a minute old: bumped and saved');
  assert.ok(Date.now() - store.getState().cacheIndex[h].lastUsed < 1000);
  torrent.closeFile(t, 0);
  await torrent.remove(h);
});

test('stats ticker: describes the file opened last, falls back when it closes, stops when none is open', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { t, files: [e1, e2] } = await loaded(H('0'), 'Show.S01E01.mkv', 'Show.S01E02.mkv');
  e1.downloaded = 100; e2.downloaded = 700;
  const out: string[] = []; const sse = new EventEmitter();
  events.addClient(Object.assign(sse, { writeHead: () => {}, write: (c: string) => { out.push(c); return true; } }) as never);
  const tick = () => { out.length = 0; ctx.mock.timers.tick(2000); const d = out.find((c) => c.startsWith('event: torrent.stats')); return d ? JSON.parse(d.split('data: ')[1]).downloaded : undefined; };
  torrent.openFile(t, 0);
  assert.equal(tick(), 100);
  torrent.openFile(t, 1);   // auto-next while episode 1 is still being read
  assert.equal(tick(), 700, 'the new episode, not the first one opened');
  torrent.openFile(t, 0); torrent.closeFile(t, 0);   // another read of episode 1 that was already open
  assert.equal(tick(), 700);
  torrent.closeFile(t, 1);
  assert.equal(tick(), 100, 'back to the file still open');
  torrent.closeFile(t, 0);
  assert.equal(tick(), undefined, 'nothing open: no ticks');
  sse.emit('close');
  await torrent.remove(t.infoHash);
});
