import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const store = await import('../server/store.ts');
const { DEFAULT_ADDONS } = await import('../server/config.ts');
after(() => { store.flushSync(); fs.rmSync(DIR, { recursive: true, force: true }); });

type Obj = Record<string, any>;
/** A scrubbed copy of a real state.json: its shape, counts and numbers, with every id, name, URL, key and time made up. */
const FIXTURE: Obj = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'state-shape.json'), 'utf8'));
const fixture = (): Obj => structuredClone(FIXTURE);
/** The fixture's times were shifted so its newest is this. */
const NEWEST = Date.UTC(2026, 0, 1);
const TIMES = new Set(['ts', 'updatedAt', 'lastUsed', 'addedAt']);
/** The fixture with every time moved so its newest is `now`: a state saved a moment ago, nothing old enough to prune. */
function rebased(now = Date.now()): Obj {
  const s = fixture();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (TIMES.has(k) && typeof x === 'number') (v as Obj)[k] = x + now - NEWEST; else walk(x); }
  };
  walk(s);
  return s;
}
const DAY = 86_400_000;
const P = (o: Obj = {}) => ({ videoId: 'tt1', metaId: 'tt1', type: 'movie', pos: 60, dur: 6000, updatedAt: 1, name: 'x', ...o });

/** Run fn with a stream captured (info logs go to stdout, warnings and errors to stderr), return what it wrote. */
function capture(stream: NodeJS.WriteStream, fn: () => void): string {
  const w = stream.write; let out = '';
  stream.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof w;
  try { fn(); } finally { stream.write = w; }
  return out;
}
const stderrOf = (fn: () => void) => capture(process.stderr, fn);

test('normalizeState: a clean real-shaped state comes back equal, nothing named, nothing dropped', () => {
  const n = store.normalizeState(fixture());
  assert.deepEqual(n.fields, []);
  assert.equal(n.droppedProgress, 0);
  assert.deepEqual(n.state, FIXTURE);
  assert.equal(JSON.stringify(n.state), JSON.stringify(FIXTURE), 'same key order too: the file it writes is the file it read');
  const older = fixture(); delete older.settings.autoNextDelaySec; delete older.intros;
  const o = store.normalizeState(older);
  assert.deepEqual(o.fields, [], 'a default filled in for a field an older build never wrote is no repair');
  assert.deepEqual([o.state.settings.autoNextDelaySec, o.state.intros], [store.DEFAULT_SETTINGS.autoNextDelaySec, {}]);
});

test('normalizeState: null fields become their empty value or default', () => {
  const raw = { settings: null, progress: null, watchlist: null, following: null, cacheIndex: null, castHistory: null, downloads: null, credits: null, intros: null, v: null };
  const n = store.normalizeState(raw);
  assert.deepEqual(n.state, { settings: store.DEFAULT_SETTINGS, progress: {}, watchlist: [], following: [], cacheIndex: {}, castHistory: {}, downloads: {}, credits: {}, intros: {}, v: 0 });
  assert.deepEqual(n.fields.sort(), Object.keys(raw).sort());
  assert.notEqual(n.state.settings.addons, store.DEFAULT_SETTINGS.addons, 'never aliases the defaults');
});

test('normalizeState: an array where a map goes, a map where a list goes', () => {
  const n = store.normalizeState({ ...fixture(), castHistory: [], progress: [P()], settings: ['x'], cacheIndex: [], credits: [30], watchlist: { id: 'tt1' }, following: {} });
  assert.deepEqual([n.state.castHistory, n.state.progress, n.state.cacheIndex, n.state.credits, n.state.watchlist, n.state.following], [{}, {}, {}, {}, [], []]);
  assert.deepEqual(n.state.settings, store.DEFAULT_SETTINGS);
  assert.deepEqual(n.fields.sort(), ['cacheIndex', 'castHistory', 'credits', 'following', 'progress', 'settings', 'watchlist']);
  assert.equal(n.droppedProgress, 0, 'a list holds no entries to count');
});

test('normalizeState: string fields; a bad setting falls back to its default, the good ones stay', () => {
  const raw = fixture();
  Object.assign(raw.settings, { addons: 'https://example.com/addon-1/manifest.json', subLangs: 'eng', autoNext: 'yes', subFontSize: '120', cacheCapBytes: 'lots', haWebhookUrl: 'javascript:x' });
  Object.assign(raw, { watchlist: 'tt1', progress: 'none', castHistory: 'x', intros: 'x', v: '2' });
  const n = store.normalizeState(raw);
  const { addons, subLangs, autoNext, subFontSize, cacheCapBytes } = store.DEFAULT_SETTINGS;
  assert.deepEqual(n.state.settings, { ...FIXTURE.settings, addons, subLangs, autoNext, subFontSize, cacheCapBytes });
  assert.deepEqual(n.state.settings.addons, DEFAULT_ADDONS);
  assert.deepEqual([n.state.watchlist, n.state.progress, n.state.castHistory, n.state.intros, n.state.v], [[], {}, {}, {}, 0]);
  assert.deepEqual(n.fields.sort(), ['castHistory', 'intros', 'progress', 'settings', 'v', 'watchlist']);
});

test('normalizeState: malformed progress entries are dropped and counted, a wrong videoId takes its key', () => {
  const ok = JSON.stringify(P());
  const raw = JSON.parse(`{"progress":{"tt1":${ok},"tt2":${ok},"tt3":null,"tt4":"x","tt5":${JSON.stringify(P({ pos: 'a' }))},"tt6":${JSON.stringify(P({ type: 'show' }))},`
    + `"tt7":${JSON.stringify(P({ metaId: '__proto__' }))},"tt8":${JSON.stringify(P({ dur: -1 }))},"tt9":{"pos":1},"__proto__":${ok}}}`);
  const n = store.normalizeState(raw);
  assert.deepEqual(Object.keys(n.state.progress), ['tt1', 'tt2']);
  assert.deepEqual(n.state.progress.tt1, P());
  assert.equal(n.state.progress.tt2.videoId, 'tt2');
  assert.equal(n.droppedProgress, 8);
  assert.deepEqual(n.fields, ['progress']);
  assert.equal(Object.getPrototypeOf(n.state.progress), Object.prototype);
});

test('normalizeState: bad list, history, cache, download, credit and intro entries are left out, good ones stay', () => {
  const tv = { ts: 1, app: 'Kino', title: 'A' }, cache = { infoHash: 'aa', name: 'n', bytes: 1, lastUsed: 1 };
  const dl = { key: 'aa:0', infoHash: 'aa', fileIdx: 0, type: 'movie', name: 'n', sizeBytes: 1, addedAt: 1, done: false };
  const n = store.normalizeState({
    watchlist: [{ id: 'tt1', type: 'movie', name: 'a', addedAt: 1 }, null, { id: 3 }, 'tt2'], following: [{ id: 'tt3', name: 'b', addedAt: 1 }, {}],
    castHistory: { tv: [tv, { ts: 'x' }, null], gone: 'x' }, cacheIndex: { aa: cache, bb: { infoHash: 'bb' }, cc: null }, downloads: { 'aa:0': dl, x: 5 },
    credits: { tt1: [30, 'x', null, 40], tt2: 'x' }, intros: { tt1: [{ start: 1, end: 90 }, { start: 'a' }], tt2: {} },
  });
  assert.deepEqual(n.state.watchlist.map((w) => w.id), ['tt1']);
  assert.deepEqual(n.state.following.map((f) => f.id), ['tt3']);
  assert.deepEqual(n.state.castHistory, { tv: [tv] });
  assert.deepEqual(n.state.cacheIndex, { aa: cache });
  assert.deepEqual(n.state.downloads, { 'aa:0': dl });
  assert.deepEqual(n.state.credits, { tt1: [30, 40] });
  assert.deepEqual(n.state.intros, { tt1: [{ start: 1, end: 90 }] });
  assert.deepEqual(n.fields.sort(), ['cacheIndex', 'castHistory', 'credits', 'downloads', 'following', 'intros', 'watchlist']);
});

test('normalizeState: unknown fields stay for the build that wrote them; unsafe keys and recentMagnets go', () => {
  const raw = JSON.parse('{"v":2,"settings":{"onboarded":true,"later":{"a":1},"__proto__":{"x":1}},"later":[1],"__proto__":{"polluted":true},"recentMagnets":[]}');
  const n = store.normalizeState(raw);
  const s = n.state as unknown as Obj;
  assert.deepEqual(s.later, [1]);
  assert.deepEqual(s.settings.later, { a: 1 });
  assert.equal('recentMagnets' in s, false);
  assert.equal(Object.getPrototypeOf(s), Object.prototype);
  assert.equal(Object.getPrototypeOf(s.settings), Object.prototype);
  assert.equal((({}) as Obj).polluted, undefined);
  assert.deepEqual(n.fields.sort(), ['__proto__', 'settings']);
});

test('load: a broken file loads, is written back fixed at once, and logs how many progress entries went', () => {
  const file = path.join(DIR, 'broken.json');
  const raw = fixture();
  raw.watchlist = null; raw.castHistory = []; raw.settings.addons = 'https://example.com/addon-1/manifest.json'; raw.progress.bad = { pos: 1 };
  fs.writeFileSync(file, JSON.stringify(raw));
  const err = stderrOf(() => store.load(file));
  assert.match(err, /"level":"warn".*"msg":"state repaired".*"droppedProgress":1/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));   // no save asked for: load wrote it
  assert.deepEqual(saved.watchlist, []);
  assert.deepEqual(saved.castHistory, {});
  assert.deepEqual(saved.settings.addons, DEFAULT_ADDONS);
  assert.equal(Object.hasOwn(saved.progress, 'bad'), false);
  assert.equal(Object.keys(saved.progress).length, Object.keys(FIXTURE.progress).length);
  assert.doesNotThrow(() => { store.getState().watchlist.map((w) => w.id); store.continueWatching(); store.finishedSeriesHeads(); store.castHistory('device-1'); });
  assert.equal(stderrOf(() => store.load(file)), '', 'the next load finds nothing to repair');
});

test('load: a migration is written back at once, without waiting for a save', () => {
  const file = path.join(DIR, 'migrate.json');
  fs.writeFileSync(file, JSON.stringify({ ...rebased(), v: 1 }));
  store.load(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, store.STATE_VERSION);
});

test('load: a clean real-shaped file is read, not rewritten', () => {
  const file = path.join(DIR, 'clean.json');
  const clean = rebased(), text = JSON.stringify(clean, null, 2);   // as the old pretty-printing build left it
  fs.writeFileSync(file, text);
  assert.equal(stderrOf(() => store.load(file)), '');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(store.getState(), clean);
});

const short = (updatedAt: number, o: Obj = {}) => P({ pos: 2, dur: 3000, updatedAt, ...o });
const cast = (...ts: number[]) => ts.map((t) => ({ ts: t, app: 'Kino', title: 'A' }));

test('pruneState: short progress over 30 days old goes unless marked watched; cast history of a receiver unseen 90 days goes', () => {
  const now = Date.UTC(2026, 5, 1), old = now - store.SHORT_PROGRESS_TTL_MS;
  const s = store.normalizeState({
    progress: { gone: short(old - 1), zero: short(old - 1, { pos: 0, dur: 0 }), recent: short(now - DAY), edge: short(old), watched: short(old - DAY, { pos: 1, dur: 1 }), real: P({ pos: 5, updatedAt: 1 }) },
    castHistory: { stale: cast(now - store.CAST_HISTORY_TTL_MS - 1, 1), live: cast(now - store.CAST_HISTORY_TTL_MS, 1), mixed: cast(now - DAY, now - 400 * DAY), empty: [] },
  }).state;
  assert.deepEqual(store.pruneState(s, now), { progress: 2, castDevices: 2 });
  assert.deepEqual(Object.keys(s.progress).sort(), ['edge', 'real', 'recent', 'watched']);
  assert.deepEqual(Object.keys(s.castHistory).sort(), ['live', 'mixed']);
  assert.equal(s.castHistory.mixed.length, 2, 'a receiver still in use keeps its whole history');
  assert.equal(store.SHORT_PROGRESS_TTL_MS, 30 * DAY);
  assert.equal(store.CAST_HISTORY_TTL_MS, 90 * DAY);
});

test('pruneState: a real-shaped state saved a day ago loses nothing', () => {
  const s = store.normalizeState(fixture()).state;
  assert.deepEqual(store.pruneState(s, NEWEST + DAY), { progress: 0, castDevices: 0 });
  assert.deepEqual(s, FIXTURE);
});

test('load: prunes, logs it and writes the smaller file at once', () => {
  const file = path.join(DIR, 'prune.json');
  const now = Date.now(), raw = rebased(now);
  raw.progress.old = short(now - 40 * DAY, { videoId: 'old' });
  raw.castHistory.gone = cast(now - 100 * DAY);
  fs.writeFileSync(file, JSON.stringify(raw));
  const out = capture(process.stdout, () => store.load(file));
  assert.match(out, /"msg":"pruned".*"progress":1,"castDevices":1/);
  const s = store.getState();
  assert.equal(Object.hasOwn(s.progress, 'old'), false);
  assert.equal(Object.hasOwn(s.castHistory, 'gone'), false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));   // no save asked for: load wrote it
  assert.deepEqual(saved, rebased(now));
});

test('flush writes compact JSON, still through a synced tmp file renamed over the old one', () => {
  const file = path.join(DIR, 'compact.json');
  fs.writeFileSync(file, JSON.stringify(rebased(), null, 2));
  const pretty = fs.statSync(file).size;
  store.load(file);
  store.update(() => {}); store.flushSync();
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, JSON.stringify(store.getState()));
  assert.equal(text.includes('\n'), false);
  assert.ok(text.length < pretty * 0.8, `${text.length} bytes compact against ${pretty} pretty`);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
