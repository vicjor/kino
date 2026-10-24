import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const store = await import('../server/store.ts');
const { DEFAULT_ADDONS } = await import('../server/config.ts');
const ids = await import('../server/subs/ids.ts');
after(() => { store.flushSync(); fs.rmSync(DIR, { recursive: true, force: true }); });

/** Run fn with stderr captured (the store logs errors there), return what it wrote. */
function stderrOf(fn: () => void): string {
  const w = process.stderr.write; let out = '';
  process.stderr.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof w;
  try { fn(); } finally { process.stderr.write = w; }
  return out;
}

test('load fresh, update, atomic flush, reload', () => {
  const file = path.join(process.env.KINO_DATA!, 'state.json');
  store.load(file);
  store.saveProgress({ videoId: 'tt1:1:2', metaId: 'tt1', type: 'series', pos: 100, dur: 1000, updatedAt: 1, name: 'x' });
  store.flushSync();
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '.tmp'));
  const s = store.load(file);
  assert.equal(s.progress['tt1:1:2'].pos, 100);
  assert.deepEqual(s.settings.subLangs, ['eng', 'nor']);
});

// saveProgress stamps updatedAt itself; the ordering tests write entries straight in to control it.
const T = Date.now() + 60_000;   // after anything saveProgress stamped above
const put = (p: Parameters<typeof store.saveProgress>[0]) => store.update((s) => { s.progress[p.videoId] = { ...p, updatedAt: T + p.updatedAt }; });

test('continue watching: latest per show, hides finished, keeps anything actually started', () => {
  put({ videoId: 'tt1:1:3', metaId: 'tt1', type: 'series', pos: 200, dur: 1000, updatedAt: 2, name: 'x' });
  put({ videoId: 'tt2', metaId: 'tt2', type: 'movie', pos: 990, dur: 1000, updatedAt: 3, name: 'done' });
  put({ videoId: 'tt3', metaId: 'tt3', type: 'movie', pos: 10, dur: 1000, updatedAt: 4, name: 'a few seconds in still counts' });
  put({ videoId: 'tt4', metaId: 'tt4', type: 'movie', pos: 2, dur: 1000, updatedAt: 5, name: 'logo only' });
  const cw = store.continueWatching();
  assert.deepEqual(cw.map((p) => p.videoId), ['tt3', 'tt1:1:3']);
});

test('finished series heads: shows whose latest episode is done, not ones mid-episode, not movies', () => {
  put({ videoId: 'tt5:1:1', metaId: 'tt5', type: 'series', pos: 980, dur: 1000, updatedAt: 6, name: 'done ep' });
  put({ videoId: 'tt6:1:1', metaId: 'tt6', type: 'series', pos: 980, dur: 1000, updatedAt: 7, name: 'done then started next' });
  put({ videoId: 'tt6:1:2', metaId: 'tt6', type: 'series', pos: 100, dur: 1000, updatedAt: 8, name: 'next in progress' });
  put({ videoId: 'tt7:1:1', metaId: 'tt7', type: 'series', pos: 1, dur: 1, updatedAt: 9, name: 'marked watched by hand' });
  assert.deepEqual(store.finishedSeriesHeads().map((p) => p.videoId), ['tt5:1:1']);
});

test('corrupt state file -> fresh, the original moved aside byte for byte and logged', () => {
  const file = path.join(DIR, 'bad.json');
  const bytes = '{"progress":{"tt1":{"pos":1}},"settings":{"tmdbKey":"k"'; // torn mid-write
  fs.writeFileSync(file, bytes);
  let s!: ReturnType<typeof store.load>;
  const err = stderrOf(() => { s = store.load(file); });
  assert.equal(Object.keys(s.progress).length, 0);
  assert.ok(!fs.existsSync(file), 'the next save must not overwrite the unreadable file in place');
  const aside = fs.readdirSync(DIR).filter((f) => f.startsWith('bad.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.match(aside[0], /^bad\.json\.corrupt-\d{13}$/);
  assert.equal(fs.readFileSync(path.join(DIR, aside[0]), 'utf8'), bytes);
  assert.match(err, /"level":"error".*moved aside/);
  for (const v of ['[]', 'null', '42']) { fs.writeFileSync(file, v); stderrOf(() => store.load(file)); assert.ok(!fs.existsSync(file), `${v} is not a state`); }
  const epoch = (f: string) => Number(f.split('.corrupt-')[1]);
  const kept = fs.readdirSync(DIR).filter((f) => f.startsWith('bad.json.corrupt-')).sort((a, b) => epoch(a) - epoch(b));
  assert.deepEqual(kept.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')), ['[]', 'null', '42'], 'the newest three, none overwritten by another in the same millisecond');
});

test('an unreadable state file: the three newest copies stay, nothing else is touched, and the store says it started fresh', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'corrupt-'));
  const file = path.join(dir, 'state.json');
  for (const at of [1000, 2000, 3000, 4000]) fs.writeFileSync(`${file}.corrupt-${at}`, String(at));
  for (const other of ['state.json.corrupt-notes', 'other.json.corrupt-500', 'state.json.tmp']) fs.writeFileSync(path.join(dir, other), 'not ours');
  fs.writeFileSync(file, '{"progress":');
  stderrOf(() => store.load(file));
  const r = store.recoveredFromCorrupt();
  assert.ok(r, 'a load that started fresh says so');
  assert.equal(r.file, file);
  assert.ok(r.movedTo && fs.readFileSync(r.movedTo, 'utf8') === '{"progress":', 'movedTo is the copy of the torn file');
  assert.ok(Math.abs(Date.now() - r.at) < 5000);
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(r.movedTo), 'other.json.corrupt-500', 'state.json.corrupt-3000', 'state.json.corrupt-4000', 'state.json.corrupt-notes', 'state.json.tmp'].sort());
  assert.equal(store.recoveredFromCorrupt(), r, 'reading it does not clear it: /health and the client can both ask');
  store.dismissRecovered();
  assert.equal(store.recoveredFromCorrupt(), undefined);
  fs.writeFileSync(file, 'nope'); stderrOf(() => store.load(file));
  assert.ok(store.recoveredFromCorrupt());
  store.load(file);   // moved aside again, so missing now: a clean start
  assert.equal(store.recoveredFromCorrupt(), undefined, 'the next load clears it');
  assert.equal(fs.readdirSync(dir).filter((f) => /^state\.json\.corrupt-\d+$/.test(f)).length, 3);
});

test('recoveryNotice: what /health says after a fresh start, where the old file went and when, gone once dismissed', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'notice-'));
  const file = path.join(dir, 'state.json');
  store.load(file);
  assert.equal(store.recoveryNotice(), undefined, 'a first run says nothing');
  fs.writeFileSync(file, '{"settings":');
  stderrOf(() => store.load(file));
  const r = store.recoveredFromCorrupt()!;
  assert.deepEqual(store.recoveryNotice(), { movedTo: r.movedTo, at: r.at });
  assert.match(path.basename(store.recoveryNotice()!.movedTo!), /^state\.json\.corrupt-\d+$/);
  assert.equal('file' in store.recoveryNotice()!, false, 'only what the callout needs');
  store.dismissRecovered();
  assert.equal(store.recoveryNotice(), undefined);
});

const prog = (videoId: string, o: Record<string, unknown> = {}) => ({ videoId, metaId: videoId, type: 'movie', pos: 60, dur: 6000, updatedAt: Date.now(), name: videoId, ...o });
/** A state file load repairs (watchlist null, an unreadable progress entry) and prunes (a mis-tap long ago, a receiver unused for months). */
const tidyable = (name: string) => JSON.stringify({
  v: 2, settings: { onboarded: true }, watchlist: null,
  progress: { [name]: prog(name), 'tt-bad': 'not progress', 'tt-tap': prog('tt-tap', { pos: 2, updatedAt: 1 }) },
  castHistory: { 'old-tv': [{ ts: 1, app: 'Kino', title: 'A' }] },
});

const mode = (f: string) => fs.statSync(f).mode & 0o777;
/** fn under umask 022, the usual default, which makes a new file 0644 unless asked otherwise. */
function withUmask<T>(fn: () => T): T { const old = process.umask(0o022); try { return fn(); } finally { process.umask(old); } }

test('a load that repairs or prunes keeps the bytes from before in state.json.bak, 0600 even when the state file was not', () => withUmask(() => {
  const dir = fs.mkdtempSync(path.join(DIR, 'bak-'));
  const file = path.join(dir, 'state.json'), bak = `${file}.bak`;
  const text = tidyable('tt-keep');
  fs.writeFileSync(file, text); fs.chmodSync(file, 0o644);   // as an older Kino left it
  const s = store.load(file);
  assert.deepEqual(Object.keys(s.progress), ['tt-keep']);
  assert.equal(fs.readFileSync(bak, 'utf8'), text, 'byte for byte');
  assert.equal(mode(bak), 0o600, 'it holds the same keys as the state file');
  assert.equal(mode(file), 0o600, 'the repaired state file too');
  assert.notEqual(fs.readFileSync(file, 'utf8'), text, 'the repair was written at once');
  assert.ok(!fs.existsSync(`${bak}.tmp`));
  const r = store.repairNotice()!;
  assert.deepEqual({ ...r, at: 0 }, { repairedFields: 2, droppedProgress: 1, prunedProgress: 1, prunedCastDevices: 1, backup: bak, at: 0 });
  assert.ok(Math.abs(Date.now() - r.at) < 5000);
  assert.equal(store.repairNotice(), r, 'reading it does not clear it');
  assert.equal(store.recoveryNotice(), undefined, 'not a fresh start');
}));

test('every save leaves state.json 0600: a new file, a chmod 600 by hand, an older 0644 file, a tmp a crash left behind', () => withUmask(() => {
  const dir = fs.mkdtempSync(path.join(DIR, 'mode-'));
  const file = path.join(dir, 'state.json');
  const save = () => { store.update(() => {}); store.flushSync(); };
  store.load(file);
  save();
  assert.equal(mode(file), 0o600, 'a new file, whatever the umask');
  fs.chmodSync(file, 0o600);
  save(); save();
  assert.equal(mode(file), 0o600, 'a chmod 600 by hand stays through the next saves');
  fs.chmodSync(file, 0o644);
  store.load(file);
  assert.equal(mode(file), 0o644, 'a clean load writes nothing');
  save();
  assert.equal(mode(file), 0o600, 'the next save tightens an older file');
  fs.writeFileSync(`${file}.tmp`, 'torn'); fs.chmodSync(`${file}.tmp`, 0o644);
  save();
  assert.equal(mode(file), 0o600, 'a leftover tmp keeps its mode when opened: set anyway');
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
}));

test('an unreadable state file moved aside is 0600 even when it was not', () => withUmask(() => {
  const dir = fs.mkdtempSync(path.join(DIR, 'mode-corrupt-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"settings":{"tmdbKey":"k"'); fs.chmodSync(file, 0o644);
  stderrOf(() => store.load(file));
  const to = store.recoveredFromCorrupt()?.movedTo;
  assert.ok(to && fs.existsSync(to));
  assert.equal(mode(to), 0o600);
  store.dismissRecovered();
}));

test('state.json.bak is the file as it was before the first repairing write of this boot; a clean load leaves it and says nothing', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'bak-once-'));
  const file = path.join(dir, 'state.json'), bak = `${file}.bak`;
  const first = tidyable('tt-first');
  fs.writeFileSync(file, first);
  store.load(file);
  store.load(file);   // now clean
  assert.equal(store.repairNotice(), undefined, 'the next load clears it, and a clean one sets none');
  assert.equal(fs.readFileSync(bak, 'utf8'), first);
  fs.writeFileSync(file, tidyable('tt-second'));
  store.load(file);
  assert.equal(fs.readFileSync(bak, 'utf8'), first, 'a later repair in the same process keeps the first copy');
  assert.equal(store.repairNotice()?.backup, bak, 'and still points at it');
  store.dismissRecovered();
  assert.equal(store.repairNotice(), undefined, 'dismissed: /health stops saying so');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'state.json.bak']);
});

test('no state.json.bak for a clean file, a migration alone, a first run or an unreadable file', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'no-bak-'));
  const file = path.join(dir, 'state.json');
  const clean = { v: 2, settings: { onboarded: true }, progress: { tt1: prog('tt1') }, watchlist: [], following: [], cacheIndex: {}, castHistory: {}, downloads: {}, credits: {}, intros: {} };
  for (const raw of [clean, { ...clean, v: 1 }]) {
    fs.writeFileSync(file, JSON.stringify(raw));
    store.load(file);
    assert.equal(store.repairNotice(), undefined, `v${raw.v}`);
  }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, store.STATE_VERSION, 'the migration was written');
  fs.rmSync(file);
  store.load(file);
  fs.writeFileSync(file, '{"progress":');
  stderrOf(() => store.load(file));
  assert.equal(store.repairNotice(), undefined);
  assert.ok(store.recoveryNotice());
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.bak')));
  store.dismissRecovered();
});

test('a repair whose copy cannot be written is still saved, logged, and the notice names no copy', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'bak-fail-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, tidyable('tt-x'));
  fs.mkdirSync(`${file}.bak.tmp`);   // the copy's tmp write fails, as it would on a full disk
  const err = stderrOf(() => store.load(file));
  assert.match(err, /"level":"warn".*could not keep a copy/);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  assert.equal(store.repairNotice()?.backup, undefined);
  assert.equal(store.repairNotice()?.prunedProgress, 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).progress), ['tt-x'], 'the repair is on disk');
  store.dismissRecovered();
});

test('a load that only prunes keeps the copy from before but sets no notice; a repair with a prune names both', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'prune-only-'));
  const file = path.join(dir, 'state.json'), bak = `${file}.bak`;
  const text = JSON.stringify({ v: 2, settings: { onboarded: true }, progress: { 'tt-keep': prog('tt-keep'), 'tt-tap': prog('tt-tap', { pos: 2, updatedAt: 1 }) }, castHistory: { 'old-tv': [{ ts: 1, app: 'Kino', title: 'A' }] } });
  fs.writeFileSync(file, text);
  store.load(file);
  assert.equal(store.repairNotice(), undefined, 'housekeeping a busy install does every few days: nothing to dismiss');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([Object.keys(saved.progress), saved.castHistory], [['tt-keep'], {}], 'the prune is on disk');
  assert.equal(fs.readFileSync(bak, 'utf8'), text, 'and the bytes from before are kept all the same');
  fs.writeFileSync(file, tidyable('tt-x'));
  store.load(file);
  assert.deepEqual({ ...store.repairNotice(), at: 0 }, { repairedFields: 2, droppedProgress: 1, prunedProgress: 1, prunedCastDevices: 1, backup: bak, at: 0 });
  store.dismissRecovered();
});

test('worthTelling: a repaired field or an unreadable progress entry is, pruning alone is not', () => {
  const c = (o: Partial<Parameters<typeof store.worthTelling>[0]>) => ({ repairedFields: 0, droppedProgress: 0, prunedProgress: 0, prunedCastDevices: 0, ...o });
  assert.equal(store.worthTelling(c({ repairedFields: 1 })), true);
  assert.equal(store.worthTelling(c({ droppedProgress: 1 })), true);
  assert.equal(store.worthTelling(c({ repairedFields: 1, prunedProgress: 3, prunedCastDevices: 2 })), true);
  assert.equal(store.worthTelling(c({ prunedProgress: 3, prunedCastDevices: 2 })), false);
  assert.equal(store.worthTelling(c({})), false);
});

test('repairCounts: undefined when nothing was repaired or pruned, else every count', () => {
  assert.equal(store.repairCounts({ fields: [], droppedProgress: 0 }, { progress: 0, castDevices: 0 }), undefined);
  assert.deepEqual(store.repairCounts({ fields: ['watchlist'], droppedProgress: 0 }, { progress: 0, castDevices: 0 }), { repairedFields: 1, droppedProgress: 0, prunedProgress: 0, prunedCastDevices: 0 });
  assert.deepEqual(store.repairCounts({ fields: [], droppedProgress: 0 }, { progress: 0, castDevices: 2 }), { repairedFields: 0, droppedProgress: 0, prunedProgress: 0, prunedCastDevices: 2 });
});

test('staleCorruptCopies: past the newest three by the time in the name, numbers compared as numbers, other names never', () => {
  const names = ['state.json', 'state.json.tmp', 'state.json.corrupt-1700000000003', 'state.json.corrupt-999', 'state.json.corrupt-1700000000001',
    'state.json.corrupt-1700000000002', 'state.json.corrupt-x', 'state.json.corrupt-1700000000004.bak', 'other.json.corrupt-1', 'state.json.corrupt-1700000000004'];
  assert.deepEqual(store.staleCorruptCopies(names, 'state.json'), ['state.json.corrupt-1700000000001', 'state.json.corrupt-999']);
  assert.deepEqual(store.staleCorruptCopies(names, 'state.json', 4), ['state.json.corrupt-999']);
  assert.deepEqual(store.staleCorruptCopies(['state.json.corrupt-1', 'state.json.corrupt-2'], 'state.json'), []);
  assert.equal(store.KEEP_CORRUPT, 3);
});

test('saves go back to the file last loaded, the 500 ms timer too, never to the default file', (ctx) => {
  store.flushSync();
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const def = path.join(DIR, 'state.json'), file = path.join(DIR, 'elsewhere.json');
  const before = read(def);
  store.load(file);
  const p = { videoId: 'tt-else', metaId: 'tt-else', type: 'movie' as const, pos: 100, dur: 1000, updatedAt: 1, name: 'x' };
  store.saveProgress(p);
  ctx.mock.timers.tick(store.FLUSH_MS - 1);
  assert.equal(read(file), null, 'changes wait for the timer');
  ctx.mock.timers.tick(1);
  assert.equal(JSON.parse(read(file)!).progress['tt-else'].pos, 100, 'the timer wrote the loaded file');
  store.saveProgress({ ...p, pos: 200 });
  store.flushSync();
  assert.equal(JSON.parse(read(file)!).progress['tt-else'].pos, 200);
  assert.equal(read(def), before, 'the default state file is untouched');
});

test('missing state file -> fresh, nothing moved aside, nothing logged as an error', () => {
  const file = path.join(DIR, 'none.json');
  const err = stderrOf(() => store.load(file));
  assert.equal(err, '');
  assert.equal(fs.readdirSync(DIR).filter((f) => f.startsWith('none.json')).length, 0);
  assert.equal(store.recoveredFromCorrupt(), undefined, 'a first run is not a recovery');
});

test('subtitle choice is remembered per video, off sticks, language follows the track', () => {
  put({ videoId: 'tt8', metaId: 'tt8', type: 'movie', pos: 300, dur: 6000, updatedAt: 10, name: 'x' });
  store.saveSubChoice('tt8', { subId: 'os:3', subLang: 'nor', subOffsetMs: 250 });
  assert.deepEqual([store.getProgress('tt8')!.subId, store.getProgress('tt8')!.subLang, store.getProgress('tt8')!.subOffsetMs], ['os:3', 'nor', 250]);
  store.saveSubChoice('tt8', { subId: null });
  assert.equal(store.getProgress('tt8')!.subId, null);
  assert.equal(store.getProgress('tt8')!.subLang, undefined);
  assert.equal(store.getProgress('tt8')!.subOffsetMs, 250);   // the sync offset survives a toggle
  store.saveSubChoice('nope', { subId: 'os:1' });   // nothing watched: nothing to attach it to
  assert.equal(store.getProgress('nope'), undefined);
});

test('a failed write (disk full) keeps the change for the next flush instead of throwing it away', () => {
  const file = path.join(DIR, 'full.json');
  store.load(file);
  fs.mkdirSync(`${file}.tmp`);   // the tmp write fails, as it would with ENOSPC
  store.saveProgress({ videoId: 'keep', metaId: 'keep', type: 'movie', pos: 100, dur: 1000, updatedAt: 1, name: 'x' });
  const err = stderrOf(() => assert.doesNotThrow(() => store.flush(file)));
  assert.match(err, /"level":"error".*state write failed/);
  assert.ok(!fs.existsSync(file));
  fs.rmdirSync(`${file}.tmp`);
  store.flush(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).progress.keep.pos, 100);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('v0 state gains the default addons and the current version, keeps its own, and load saves the migration', () => {
  const file = path.join(DIR, 'v0.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { addons: ['https://example.com/meta/manifest.json'], onboarded: false }, progress: {} }));
  const s = store.load(file);
  assert.equal(s.v, store.STATE_VERSION);
  assert.deepEqual(s.settings.addons, ['https://example.com/meta/manifest.json', ...DEFAULT_ADDONS]);
  assert.equal(s.settings.onboarded, false);   // an explicit answer is kept
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.v, store.STATE_VERSION);
  assert.deepEqual(saved.settings.addons, s.settings.addons);
});

test('an install from before the walkthrough skips it once something was watched, a new one does not', () => {
  const file = path.join(DIR, 'old.json');
  fs.writeFileSync(file, JSON.stringify({ settings: {}, progress: { tt9: { videoId: 'tt9', metaId: 'tt9', type: 'movie', pos: 60, dur: 6000, updatedAt: 1, name: 'x' } } }));
  assert.equal(store.load(file).settings.onboarded, true);
  fs.writeFileSync(file, JSON.stringify({ settings: {}, progress: {} }));
  const s = store.load(file);
  assert.equal(s.settings.onboarded, false);
  assert.deepEqual(s.settings.addons, DEFAULT_ADDONS);
  s.settings.addons.push('https://example.com/other/manifest.json');
  assert.deepEqual(store.DEFAULT_SETTINGS.addons, DEFAULT_ADDONS, 'loaded addons must not alias the defaults');
});

test('a state file holding the old recentMagnets list drops it, and the next save leaves it out', () => {
  const file = path.join(DIR, 'magnets.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, settings: { onboarded: true }, progress: {}, recentMagnets: [{ magnet: 'magnet:?xt=urn:btih:aa', name: 'x', addedAt: 1 }] }));
  assert.equal('recentMagnets' in store.load(file), false);
  store.update(() => {}); store.flushSync();
  assert.equal('recentMagnets' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
});

test('finished means past 95 percent, strictly; no duration is never finished', () => {
  const p = (pos: number, dur: number) => ({ videoId: 'v', metaId: 'm', type: 'movie' as const, pos, dur, updatedAt: 0, name: 'x' });
  assert.equal(store.isFinished(p(95, 100)), false);
  assert.equal(store.isFinished(p(95.01, 100)), true);
  assert.equal(store.isFinished(p(100, 100)), true);
  assert.equal(store.isFinished(p(50, 0)), false);
});

test('marked watched is pos 1 of dur 1: finished, never a real play', () => {
  const p = (pos: number, dur: number) => ({ videoId: 'v', metaId: 'm', type: 'series' as const, pos, dur, updatedAt: 0, name: 'x' });
  assert.equal(store.isMarkedWatched(p(1, 1)), true);
  assert.equal(store.isFinished(p(1, 1)), true);
  for (const x of [p(1, 2), p(2, 1), p(0, 1), p(1000, 1000), undefined, null, { pos: 1 }, { pos: '1', dur: 1 }]) assert.equal(store.isMarkedWatched(x), false, JSON.stringify(x));
  assert.equal(store.FINISHED_SHARE, 0.95);
});

const P = (o: Partial<Parameters<typeof store.mergeProgress>[0] & object> = {}) => ({ videoId: 'tt9:1:2', metaId: 'tt9', type: 'series' as const, pos: 1200, dur: 2400, updatedAt: 1, name: 'Show S1 E2', ...o });

test('mergeProgress: an early position never overwrites a real one, a later or first one does', () => {
  assert.equal(store.mergeProgress(P(), { pos: 2, dur: 2400 }, 'tt9:1:2', 5).pos, 1200, 'a player that has not seeked yet');
  assert.equal(store.mergeProgress(P(), { pos: 0 }, 'tt9:1:2', 5).pos, 1200);
  assert.equal(store.mergeProgress(P(), { pos: 5 }, 'tt9:1:2', 5).pos, 5, 'at the floor it is a real position');
  assert.equal(store.mergeProgress(P(), { pos: 600 }, 'tt9:1:2', 5).pos, 600, 'going back is allowed');
  assert.equal(store.mergeProgress(P({ pos: 1 }), { pos: 2 }, 'tt9:1:2', 5).pos, 2);
  assert.equal(store.mergeProgress(undefined, { pos: 2, dur: 100 }, 'tt9:1:2', 5).pos, 2, 'nothing stored: kept');
  assert.equal(store.mergeProgress(P(), {}, 'tt9:1:2', 5).pos, 1200, 'no position: the stored one');
});

test('mergeProgress: mark as watched passes over a real position', () => {
  const m = store.mergeProgress(P(), { pos: 1, dur: 1 }, 'tt9:1:2', 5);
  assert.deepEqual([m.pos, m.dur], [1, 1]);
  assert.ok(store.isMarkedWatched(m) && store.isFinished(m));
});

test('mergeProgress: subtitle off (null) sticks, absent keeps the stored choice, a pick replaces it', () => {
  const had = P({ subId: 'abc.tag', subLang: 'nor', subOffsetMs: 300 });
  const off = store.mergeProgress(had, { pos: 1300, subId: null }, 'tt9:1:2', 5);
  assert.deepEqual([off.subId, off.subLang, off.subOffsetMs], [null, undefined, 300]);
  const kept = store.mergeProgress(off, { pos: 1400 }, 'tt9:1:2', 6);
  assert.deepEqual([kept.subId, kept.subLang], [null, undefined], 'off survives a save that says nothing');
  const keep2 = store.mergeProgress(had, { pos: 1400 }, 'tt9:1:2', 6);
  assert.deepEqual([keep2.subId, keep2.subLang], ['abc.tag', 'nor']);
  const pick = store.mergeProgress(off, { subId: 'def.tag', subLang: 'eng', subOffsetMs: -200 }, 'tt9:1:2', 7);
  assert.deepEqual([pick.subId, pick.subLang, pick.subOffsetMs], ['def.tag', 'eng', -200]);
});

test('mergeProgress: fields fall back body, then stored, then the video id', () => {
  const first = store.mergeProgress(undefined, { pos: 60 }, 'tt9:2:3', 42);
  assert.deepEqual(first, { videoId: 'tt9:2:3', metaId: 'tt9', type: 'series', pos: 60, dur: 0, updatedAt: 42, name: 'tt9:2:3', poster: undefined, background: undefined, season: 2, episode: 3, infoHash: undefined, fileIdx: undefined, subId: undefined, subLang: undefined, subOffsetMs: undefined });
  assert.equal(store.mergeProgress(undefined, {}, 'tt1', 1).type, 'movie');
  const m = store.mergeProgress(P({ poster: 'p', infoHash: 'h', fileIdx: 2 }), { pos: 1300, name: 'Show S1 E2 Title' }, 'tt9:1:2', 9);
  assert.deepEqual([m.name, m.poster, m.infoHash, m.fileIdx, m.dur, m.updatedAt], ['Show S1 E2 Title', 'p', 'h', 2, 2400, 9]);
});

test('progressBody: finite seconds, movie or series, text where text goes; anything else a 400', () => {
  const st = (e: unknown) => (e as { status?: number }).status;
  assert.deepEqual(store.progressBody(undefined), {});
  assert.deepEqual(store.progressBody({ pos: 10, dur: 100, type: 'movie', subId: null, season: null }), { pos: 10, dur: 100, type: 'movie', subId: null, season: null });
  for (const b of [{ pos: '10' }, { pos: -1 }, { dur: 'x' }, { pos: 1e400 }, { pos: {} }, { type: 'show' }, { type: 3 }, { season: '1' }, { fileIdx: 'a' }, { subOffsetMs: 'x' }, { name: 3 }, { subId: 4 }, { metaId: '__proto__' }, [], 'str', 5]) {
    assert.throws(() => store.progressBody(b), (e) => st(e) === 400, JSON.stringify(b));
  }
});

test('cast history: a repeat of the head within six hours collapses, anything else is a new entry', () => {
  store.load(path.join(DIR, 'cast.json'));
  const e = (title: string, app = 'Kino') => ({ ts: Date.now(), app, title });
  assert.equal(store.addCastHistory('tv', e('A')), true);
  const head = store.castHistory('tv')[0]; head.ts -= 60_000;
  const kino = { infoHash: 'ab'.repeat(20), fileIdx: 0, title: 'A', type: 'movie' as const };
  assert.equal(store.addCastHistory('tv', { ...e('A'), kino }), false, 'same title, same app: collapsed');
  assert.equal(store.castHistory('tv').length, 1);
  assert.ok(Date.now() - store.castHistory('tv')[0].ts < 1000, 'the collapsed entry is stamped now');
  assert.deepEqual(store.castHistory('tv')[0].kino, kino, 'and picks up the Kino link it lacked');
  assert.equal(store.addCastHistory('tv', e('A', 'Other')), true, 'same title in another app is new');
  assert.equal(store.addCastHistory('tv', e('A')), true, 'not consecutive: new');
  store.castHistory('tv')[0].ts -= 7 * 3600_000;
  assert.equal(store.addCastHistory('tv', e('A')), true, 'older than six hours: new');
  assert.deepEqual(store.castHistory('tv').map((x) => `${x.app}:${x.title}`), ['Kino:A', 'Kino:A', 'Other:A', 'Kino:A']);
  assert.equal(store.addCastHistory('other', e('B')), true, 'per receiver');
  for (const t of ['C', 'D', 'E']) store.addCastHistory('tv', e(t), 3);
  assert.deepEqual(store.castHistory('tv').map((x) => x.title), ['E', 'D', 'C'], 'capped, newest first');
});

test('cast history: a status repeat inside a minute writes nothing; a minute later, or a new Kino link, does', () => {
  const file = path.join(DIR, 'cast-quiet.json');
  store.load(file);
  const e = () => ({ ts: Date.now(), app: 'Music', title: 'Song' });
  assert.equal(store.addCastHistory('speaker', e()), true);
  store.flush(file); fs.rmSync(file);
  const ts = store.castHistory('speaker')[0].ts;
  for (let i = 0; i < 5; i++) assert.equal(store.addCastHistory('speaker', e()), false);   // one status every 4 s
  store.flush(file);
  assert.equal(fs.existsSync(file), false, 'nothing new: state.json is not rewritten');
  assert.equal(store.castHistory('speaker')[0].ts, ts);
  const kino = { infoHash: 'ab'.repeat(20), fileIdx: 0, title: 'Song', type: 'movie' as const };
  assert.equal(store.addCastHistory('speaker', { ...e(), kino }), false);
  store.flush(file);
  assert.ok(fs.existsSync(file), 'a Kino link is new: saved at once');
  assert.deepEqual(store.castHistory('speaker')[0].kino, kino);
  fs.rmSync(file);
  store.castHistory('speaker')[0].ts -= store.CAST_HISTORY_TOUCH_MS;
  assert.equal(store.addCastHistory('speaker', e()), false);
  store.flush(file);
  assert.ok(fs.existsSync(file), 'a minute on: the head time moves');
  assert.ok(Date.now() - store.castHistory('speaker')[0].ts < 1000);
  assert.equal(store.castHistory('speaker').length, 1);
});

test('v1 state: subtitle ids saved before signing are signed once, payload kept, anything else left alone', () => {
  const file = path.join(DIR, 'v1-subs.json');
  const bare = (k: object) => Buffer.from(JSON.stringify(k)).toString('base64url');
  const os = bare({ o: 'os', u: 'https://example.org/a.srt', e: 'CP1252' }), tor = bare({ o: 't', h: 'ab'.repeat(20), i: 3 });
  const signed = ids.encodeSubId({ o: 'e', h: 'cd'.repeat(20), i: 0, s: 2 });
  const notKey = bare({ o: 'zz', u: 'x' }), respaced = Buffer.from('{"o": "os","u":"https://example.org/b.srt"}').toString('base64url');
  const subs: Record<string, unknown> = { a: os, b: tor, c: signed, d: null, f: 'os:3', g: notKey, h: respaced, i: '%%%', j: 42 };
  const progress = Object.fromEntries(Object.entries(subs).map(([k, subId]) => [k, { videoId: k, metaId: k, type: 'movie', pos: 60, dur: 6000, updatedAt: 1, name: k, subId }]));
  fs.writeFileSync(file, JSON.stringify({ v: 1, settings: { onboarded: true }, progress: { ...progress, e: { videoId: 'e', metaId: 'e', type: 'movie', pos: 60, dur: 6000, updatedAt: 1, name: 'e' } } }));
  const s = store.load(file);
  assert.equal(s.v, store.STATE_VERSION);
  assert.deepEqual(ids.decodeSubId(s.progress.a.subId!), { o: 'os', u: 'https://example.org/a.srt', e: 'CP1252' }, 'signed with this install key');
  assert.equal(s.progress.a.subId, ids.encodeSubId({ o: 'os', u: 'https://example.org/a.srt', e: 'CP1252' }), 'equal to the id a fresh subtitle list hands out');
  assert.equal(ids.payloadOf(s.progress.a.subId!), os, 'same payload: same disk cache file');
  assert.deepEqual(ids.decodeSubId(s.progress.b.subId!), { o: 't', h: 'ab'.repeat(20), i: 3 });
  for (const k of ['c', 'd', 'f', 'g', 'h', 'i', 'j']) assert.equal(s.progress[k].subId, subs[k], `${k} untouched`);
  assert.equal('subId' in s.progress.e, false);
  assert.ok(fs.existsSync(path.join(DIR, 'secret.key')), 'the key lives in the (temp) data dir');
  store.flush(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).progress.a.subId, s.progress.a.subId);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, store.STATE_VERSION);
  // From v2 on, a bare id saved since (by any client) is never signed.
  store.update((x) => { x.progress.a.subId = os; });
  store.flush(file);
  assert.equal(store.load(file).progress.a.subId, os);
});

test('resignLegacySubIds signs with the key it is given, once', () => {
  const key = Buffer.alloc(32, 9);
  const k = { o: 'os' as const, u: 'https://example.org/c.srt' };
  const p = { videoId: 'x', metaId: 'x', type: 'movie' as const, pos: 1, dur: 2, updatedAt: 0, name: 'x', subId: Buffer.from(JSON.stringify(k)).toString('base64url') };
  assert.equal(store.resignLegacySubIds({ x: p }, key), 1);
  assert.equal(p.subId, ids.encodeSubId(k, key));
  assert.deepEqual(ids.decodeSubId(p.subId, key), k);
  assert.equal(store.resignLegacySubIds({ x: p }, key), 0, 'already signed');
});

test('renameAutoNextEpisodes: auto-next\'s "Show S2E3 · Title" becomes "Show S2 E3 Title", nothing else changes', () => {
  const ep = (name: string, type: 'series' | 'movie' = 'series') => ({ videoId: name, metaId: 'tt1', type, pos: 600, dur: 3000, updatedAt: 1, name });
  const names: Record<string, string> = {
    'Harbor S2E3 · Solo': 'Harbor S2 E3 Solo',
    'Harbor S2E3 · undefined': 'Harbor S2 E3',
    'Harbor S2E3 · ': 'Harbor S2 E3',
    'Harbor S2E3 ·': 'Harbor S2 E3',
    ' S0E1 · Special': 'S0 E1 Special',
    'Doctor Who S12E104 · Part 1 · The Return': 'Doctor Who S12 E104 Part 1 · The Return',
  };
  const progress = Object.fromEntries(Object.keys(names).map((n, i) => [`e${i}`, ep(n)]));
  const kept = { now: ep('Harbor S2 E3 Solo'), noTitle: ep('Harbor S2 E3'), movie: ep('Film S1E2 · Cut', 'movie'), other: ep('Harbor S2E3 Solo'), dot: ep('Show · S2E3') };
  assert.equal(store.renameAutoNextEpisodes({ ...progress, ...kept }), Object.keys(names).length);
  assert.deepEqual(Object.values(progress).map((p) => p.name), Object.values(names));
  assert.deepEqual(Object.values(kept).map((p) => p.name), ['Harbor S2 E3 Solo', 'Harbor S2 E3', 'Film S1E2 · Cut', 'Harbor S2E3 Solo', 'Show · S2E3']);
  assert.equal(store.renameAutoNextEpisodes(progress), 0, 'a renamed entry is not renamed again');
});

test('v2 state: auto-next names are renamed once and saved; from v3 on a name in that shape stays as it is', () => {
  const file = path.join(DIR, 'v2-names.json');
  const ep = (videoId: string, name: string) => ({ videoId, metaId: videoId.split(':')[0], type: 'series', pos: 600, dur: 3000, updatedAt: 1, name, season: 1, episode: 2 });
  const progress = { 'tt5:1:2': ep('tt5:1:2', 'Mainframe S1E2 · Night Shift'), 'tt6:1:2': ep('tt6:1:2', 'Outpost S1E2 · undefined'), 'tt7:1:2': ep('tt7:1:2', 'Harbor S1 E2 Truth') };
  fs.writeFileSync(file, JSON.stringify({ v: 2, settings: { onboarded: true }, progress }));
  const w = process.stdout.write; let out = '';
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof w;
  let s: ReturnType<typeof store.load>;
  try { s = store.load(file); } finally { process.stdout.write = w; }
  assert.equal(s.v, store.STATE_VERSION);
  assert.deepEqual(Object.values(s.progress).map((p) => p.name), ['Mainframe S1 E2 Night Shift', 'Outpost S1 E2', 'Harbor S1 E2 Truth']);
  assert.match(out, /"msg":"renamed auto-next episodes".*"n":2/, 'logged with the count');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.v, store.STATE_VERSION, 'load wrote the migration back');
  assert.equal(saved.progress['tt5:1:2'].name, 'Mainframe S1 E2 Night Shift');
  fs.writeFileSync(file, JSON.stringify({ ...saved, progress: { ...saved.progress, 'tt8:1:2': ep('tt8:1:2', 'Dark S1E2 · Lies') } }));
  assert.equal(store.load(file).progress['tt8:1:2'].name, 'Dark S1E2 · Lies', 'one-time: a v3 file is not scanned again');
});

test('prototype keys: saves are ignored, reads see own keys only, and a state file holding one drops it', () => {
  store.load(path.join(DIR, 'proto.json'));
  for (const videoId of ['__proto__', 'constructor', '__proto__:1:2', 'toString']) {
    store.saveProgress({ videoId, metaId: videoId, type: 'movie', pos: 100, dur: 1000, updatedAt: 1, name: 'x' });
    store.saveSubChoice(videoId, { subId: 'x' });
    assert.equal(store.getProgress(videoId), undefined, videoId);
  }
  assert.equal(Object.getPrototypeOf(store.getState().progress), Object.prototype, 'the progress map keeps its prototype');
  assert.deepEqual(Object.keys(store.getState().progress), []);
  assert.equal(store.addCastHistory('__proto__', { ts: Date.now(), app: 'Kino', title: 'A' }), false);
  assert.deepEqual(store.castHistory('__proto__'), []);
  assert.deepEqual(store.castHistory('constructor'), []);
  const file = path.join(DIR, 'proto-on-disk.json');
  const p = JSON.stringify({ videoId: 'tt1', metaId: 'tt1', type: 'movie', pos: 60, dur: 6000, updatedAt: 1, name: 'x' });
  fs.writeFileSync(file, '{"v":2,"settings":{"onboarded":true},"progress":{"__proto__":{"pos":1},"tt1":' + p + '},"credits":{"constructor":[30],"tt1":[40]},"intros":{"__proto__":[]},"castHistory":{"__proto__":[]}}');
  const s = store.load(file);
  assert.deepEqual(Object.keys(s.progress), ['tt1']);
  assert.deepEqual(Object.keys(s.credits), ['tt1']);
  assert.deepEqual([Object.keys(s.intros), Object.keys(s.castHistory)], [[], []]);
  assert.equal(Object.getPrototypeOf(s.progress), Object.prototype);
});
