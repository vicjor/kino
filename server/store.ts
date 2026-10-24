import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILE, DEFAULT_ADDONS, GB } from './config.js';
import { logger } from './log.js';
import { legacySubKey, encodeSubId } from './subs/ids.js';
import { isSafeKey, safeKey, httpError } from './errors.js';
import { isFinished, isMarkedWatched } from './taste.js';
import { CAST_HISTORY_CAP, sanitizeSettings, isProgress, isListEntry, isCastEntry, isIntro } from './settings.js';
import { parseVideoId } from './meta.js';
import { episodeName } from './episode-name.js';
import type { Progress, Settings, CastHistoryEntry, Download } from './types.js';
import type { IntroSample } from './media/intro.js';

const log = logger('store');

export interface CacheEntry { infoHash: string; name: string; bytes: number; lastUsed: number }
interface FollowEntry { id: string; name: string; poster?: string; addedAt: number }
interface WatchEntry { id: string; type: 'movie' | 'series'; name: string; poster?: string; addedAt: number }

export interface State {
  settings: Settings;
  progress: Record<string, Progress>;
  watchlist: WatchEntry[];
  following: FollowEntry[];
  cacheIndex: Record<string, CacheEntry>;
  castHistory: Record<string, CastHistoryEntry[]>;   // per receiver id, newest first
  downloads: Record<string, Download>;
  credits: Record<string, number[]>;   // per metaId: seconds before the end you pressed "next", last five
  intros: Record<string, IntroSample[]>;   // per metaId: where you skipped the opening titles, last five
  v: number;              // schema version for migrations
}

export const DEFAULT_SETTINGS: Settings = {
  addons: [...DEFAULT_ADDONS],
  subLangs: ['eng', 'nor'],
  cacheCapBytes: 10 * GB,
  minFreeBytes: 3 * GB,
  subFontSize: 100,
  autoNext: true,
  autoNextDelaySec: 10,
  onboarded: false,
};

/**
 * Schema version. v1: the subtitles addon is a default. v2: subtitle ids saved before signing are signed.
 * v3: episodes auto-next saved as "Show S2E3 · Title" are renamed to episodeName's "Show S2 E3 Title".
 */
export const STATE_VERSION = 3;

function fresh(): State {
  return { settings: { ...DEFAULT_SETTINGS, addons: [...DEFAULT_ADDONS] }, progress: {}, watchlist: [], following: [], cacheIndex: {}, castHistory: {}, downloads: {}, credits: {}, intros: {}, v: STATE_VERSION };
}

/**
 * Saved subtitle choices from before ids were signed hold bare ids, and everything that restores a choice
 * compares ids for equality, so sign them. Only in the v1 -> v2 migration: doing it on every load would sign
 * any bare id a client saved since, which is exactly what signing exists to refuse. Returns how many changed.
 */
export function resignLegacySubIds(progress: Record<string, Progress>, root?: Buffer): number {
  let n = 0;
  for (const p of Object.values(progress)) {
    const k = p && typeof p === 'object' ? legacySubKey(p.subId) : undefined;
    if (k) { p.subId = encodeSubId(k, root); n++; }
  }
  return n;
}

/** Auto-next's old cast title: "Show S2E3 · Title", "· undefined" when the episode had no title. */
const AUTO_NEXT_NAME = /^(?:(.*?) )?S(\d+)E(\d+) ·(?: (.*))?$/;

/**
 * Auto-next cast episodes as "Show S2E3 · Title" and saved that name, so Continue watching and the history showed
 * "· Title" as the episode. Renames those, in place, to episodeName's "Show S2 E3 Title", once: the v2 -> v3
 * migration. Only series entries; a name in any other shape is left alone. Returns how many changed.
 */
export function renameAutoNextEpisodes(progress: Record<string, Progress>): number {
  let n = 0;
  for (const p of Object.values(progress)) {
    const m = p.type === 'series' ? AUTO_NEXT_NAME.exec(p.name) : null;
    if (!m) continue;
    p.name = episodeName(m[1], Number(m[2]), Number(m[3]), m[4] === 'undefined' ? undefined : m[4]);
    n++;
  }
  return n;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** The same JSON whatever the key order: a field normalizeState left as it was. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Own, safe keys of a plain object whose entries `clean` keeps (undefined drops one); anything not a plain object is no entries. */
function mapOf<T>(raw: unknown, clean: (v: unknown, k: string) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (isObj(raw)) for (const [k, v] of Object.entries(raw)) { const c = isSafeKey(k) ? clean(v, k) : undefined; if (c !== undefined) out[k] = c; }
  return out;
}
const isCacheEntry = (v: unknown): v is CacheEntry => isObj(v) && typeof v.infoHash === 'string' && typeof v.name === 'string' && finite(v.bytes) && finite(v.lastUsed);
const isDownload = (v: unknown): v is Download => isObj(v) && typeof v.key === 'string' && typeof v.infoHash === 'string' && finite(v.fileIdx);

/**
 * Settings from a state file, each field through sanitizeSettings on its own: a wrong one falls back to its default
 * (or goes, when it has none), the rest stay. A field this build does not know (a newer build's, before a rollback) is
 * kept. `fixed` when a field present was changed or left out; a default filled in for a missing one is no repair.
 */
function normalizeSettings(raw: unknown): { settings: Settings; fixed: boolean } {
  const out: Obj = { ...DEFAULT_SETTINGS, addons: [...DEFAULT_ADDONS] };
  let fixed = !isObj(raw);
  for (const [k, v] of Object.entries(isObj(raw) ? raw : {})) {
    if (!isSafeKey(k)) { fixed = true; continue; }
    const { settings, errors } = sanitizeSettings({ [k]: v });
    if (Object.hasOwn(settings, k)) {
      const c = (settings as Obj)[k];
      if (c === undefined) delete out[k]; else out[k] = c;
      if (!same(c, v)) fixed = true;
    } else if (errors.length) fixed = true;
    else out[k] = v;
  }
  return { settings: out as unknown as Settings, fixed };
}

/** What normalizeState changed: the top-level fields it repaired, and how many progress entries it left out. */
export interface Normalized { state: State; fields: string[]; droppedProgress: number }

/**
 * A parsed state file as a State, every field its type: a hand edit or a half-bad file (watchlist null, castHistory an
 * array, addons a string) would otherwise load and throw later on every /home or cast status. Wrong types become
 * their empty value or default, malformed entries are left out, unsafe keys too. A missing top-level field is filled
 * without counting as a repair; a v that is no number reads as 0 and the migrations run. Pure: a clean state comes
 * back equal, with no fields named.
 */
export function normalizeState(raw: Obj): Normalized {
  const settings = normalizeSettings(raw.settings);
  const state: State = {
    settings: settings.settings,
    progress: mapOf(raw.progress, (v, k) => (isProgress(v) ? (v.videoId === k ? v : { ...v, videoId: k }) : undefined)),
    watchlist: (Array.isArray(raw.watchlist) ? raw.watchlist.filter(isListEntry) : []) as WatchEntry[],
    following: (Array.isArray(raw.following) ? raw.following.filter(isListEntry) : []) as FollowEntry[],
    cacheIndex: mapOf(raw.cacheIndex, (v) => (isCacheEntry(v) ? v : undefined)),
    castHistory: mapOf(raw.castHistory, (v) => (Array.isArray(v) ? v.filter(isCastEntry) : undefined)),
    downloads: mapOf(raw.downloads, (v) => (isDownload(v) ? v : undefined)),
    credits: mapOf(raw.credits, (v) => (Array.isArray(v) ? v.filter(finite) : undefined)),
    intros: mapOf(raw.intros, (v) => (Array.isArray(v) ? v.filter(isIntro) : undefined)),
    v: finite(raw.v) ? raw.v : 0,
  };
  const out = state as unknown as Obj;
  // recentMagnets was a write-only list of added magnets, never read: gone from the file on the next save. Anything else unknown stays.
  for (const [k, v] of Object.entries(raw)) if (!Object.hasOwn(out, k) && isSafeKey(k) && k !== 'recentMagnets') out[k] = v;
  const fields = Object.keys(raw).filter((k) => (k === 'settings' ? settings.fixed : k !== 'recentMagnets' && !same(raw[k], Object.hasOwn(out, k) ? out[k] : undefined)));
  const droppedProgress = isObj(raw.progress) ? Object.keys(raw.progress).length - Object.keys(state.progress).length : 0;
  return { state, fields, droppedProgress };
}

const DAY_MS = 86_400_000;
/** A progress entry under MIN_PROGRESS_SEC (a studio logo, a mis-tap) left this long is never coming back: dropped on load. */
export const SHORT_PROGRESS_TTL_MS = 30 * DAY_MS;
/** Cast history of a receiver nothing has played on for this long (replaced, a friend's): dropped on load. */
export const CAST_HISTORY_TTL_MS = 90 * DAY_MS;

/**
 * Drops, in place, what only grows the file: progress under MIN_PROGRESS_SEC not saved for SHORT_PROGRESS_TTL_MS
 * (a mark as watched stays, it is pos 1 on purpose), and the cast history of a receiver whose newest entry is older
 * than CAST_HISTORY_TTL_MS. Entries are stamped while something plays, so that is the last time Kino saw it in use.
 */
export function pruneState(s: State, now: number): { progress: number; castDevices: number } {
  let progress = 0, castDevices = 0;
  for (const [k, p] of Object.entries(s.progress)) {
    if (p.pos < MIN_PROGRESS_SEC && now - p.updatedAt > SHORT_PROGRESS_TTL_MS && !isMarkedWatched(p)) { delete s.progress[k]; progress++; }
  }
  for (const [k, l] of Object.entries(s.castHistory)) if (!l.some((e) => now - e.ts <= CAST_HISTORY_TTL_MS)) { delete s.castHistory[k]; castDevices++; }
  return { progress, castDevices };
}

let state: State = fresh();
let dirty = false;
let timer: NodeJS.Timeout | null = null;
/** The file the state came from: every save, the timer's too, goes back there. */
let stateFile = STATE_FILE;

/** The last load found the state file unreadable and started fresh. `movedTo` is where the old file went, when it could be moved. */
export interface CorruptRecovery { file: string; movedTo?: string; at: number }
let recovered: CorruptRecovery | undefined;
/** Set by a load that had to start fresh, for /health or the client to tell you once; cleared by the next load or dismissRecovered. */
export function recoveredFromCorrupt(): CorruptRecovery | undefined { return recovered; }
/** The same for the unlocked /health: where the old file went (when it could be moved) and when, until dismissed. */
export function recoveryNotice(): { movedTo?: string; at: number } | undefined { return recovered && { movedTo: recovered.movedTo, at: recovered.at }; }
/** Clears both notices: a load sets one at most (a fresh start repairs and prunes nothing). */
export function dismissRecovered(): void { recovered = undefined; repaired = undefined; }

/**
 * The last load repaired the state and wrote it back: how many top-level fields it repaired, progress entries it left
 * out as unreadable, short progress and receivers' cast history it pruned along the way, and where the bytes from before went.
 */
export interface RepairNotice { repairedFields: number; droppedProgress: number; prunedProgress: number; prunedCastDevices: number; backup?: string; at: number }
type RepairCounts = Omit<RepairNotice, 'backup' | 'at'>;
let repaired: RepairNotice | undefined;
/** For /health to say once, like recoveryNotice; cleared by the next load or dismissRecovered. */
export function repairNotice(): RepairNotice | undefined { return repaired; }
/** What a load repaired and pruned, or undefined when it did neither. Pure. */
export function repairCounts(n: Pick<Normalized, 'fields' | 'droppedProgress'>, pruned: { progress: number; castDevices: number }): RepairCounts | undefined {
  const c = { repairedFields: n.fields.length, droppedProgress: n.droppedProgress, prunedProgress: pruned.progress, prunedCastDevices: pruned.castDevices };
  return Object.values(c).some(Boolean) ? c : undefined;
}
/**
 * A repair is worth a notice, pruning alone is not: a busy install prunes a mis-tap or an old receiver every few days,
 * and a notice that keeps coming back gets dismissed unread. The prune is still logged and kept in the .bak. Pure.
 */
export function worthTelling(c: RepairCounts): boolean { return c.repairedFields > 0 || c.droppedProgress > 0; }

export function load(file = STATE_FILE): State {
  stateFile = file;
  recovered = undefined; repaired = undefined;
  let changed = false;   // repaired, migrated or pruned: written back at once, not left for the next save
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw)) throw new Error('state is not an object');
    const n = normalizeState(raw);
    state = n.state;
    if (n.fields.length) { changed = true; log.warn('state repaired', { file, fields: n.fields, droppedProgress: n.droppedProgress }); }
    if (!state.v) { // v0 -> v1: subtitles addon became a default
      for (const a of DEFAULT_ADDONS) if (!state.settings.addons.includes(a)) state.settings.addons.push(a);
      state.v = 1; changed = true;
    }
    if (!(state.v >= 2)) {   // v1 -> v2: sign subtitle ids saved before signing
      const signed = resignLegacySubIds(state.progress);
      state.v = 2; changed = true;
      if (signed) log.info('signed saved subtitle ids', { n: signed });
    }
    if (!(state.v >= 3)) {   // v2 -> v3: auto-next's "Show S2E3 · Title" names in the format everything else saves
      const renamed = renameAutoNextEpisodes(state.progress);
      state.v = 3; changed = true;
      if (renamed) log.info('renamed auto-next episodes', { n: renamed });
    }
    // Installs from before the walkthrough existed: anyone who has watched something or added a stream addon skips it.
    const onboarded = isObj(raw.settings) ? raw.settings.onboarded : undefined;
    if (onboarded == null && (Object.keys(state.progress).length || state.settings.addons.length > DEFAULT_ADDONS.length)) { state.settings.onboarded = true; changed = true; }
    const pruned = pruneState(state, Date.now());
    if (pruned.progress || pruned.castDevices) { changed = true; log.info('pruned', { file, ...pruned }); }
    const counts = repairCounts(n, pruned);
    if (counts) {
      const backup = backupOnce(file, text);   // before the write below, for a prune too
      if (worthTelling(counts)) repaired = { ...counts, backup, at: Date.now() };
    }
    log.info('loaded', { file, progress: Object.keys(state.progress).length });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') recovered = { file, movedTo: setAside(file, e), at: Date.now() };
    state = fresh();
  }
  if (changed) { dirty = true; flush(); }
  return state;
}

/** Owner read and write only: the state holds API keys and the webhook URL, and so do its .bak and .corrupt copies. */
const PRIVATE = 0o600;

/** Files whose bytes from before a repairing or pruning load are kept in `<file>.bak` by this process. */
const backedUp = new Set<string>();
/**
 * One `<file>.bak`: the bytes a load read, before the first write of this process that repaired or pruned them. A later
 * load leaves it alone, so it stays the file as it was at boot. 0600, like every state write. Returns its path, or
 * undefined when it could not be written (the repair is still saved: the next change would save it anyway).
 */
function backupOnce(file: string, text: string): string | undefined {
  const to = `${file}.bak`;
  if (backedUp.has(file)) return to;
  try { writeAtomic(to, text); }
  catch (e) { log.warn('could not keep a copy of the state before repairing it', { to, err: String(e) }); return undefined; }
  backedUp.add(file);
  log.info('kept a copy of the state from before repairing it', { to });
  return to;
}

/** Copies of unreadable state files kept beside it: enough to recover from, not a pile that grows forever. */
export const KEEP_CORRUPT = 3;

/**
 * An unreadable state.json is moved aside, never overwritten: the next save would wipe progress, lists, addons and keys.
 * Only the newest KEEP_CORRUPT copies stay, each 0600 (a hand-made file may have been 0644). Returns where it went, or
 * undefined when it could not be moved.
 */
function setAside(file: string, e: unknown): string | undefined {
  let at = Date.now();
  while (fs.existsSync(`${file}.corrupt-${at}`)) at++;   // two in one millisecond must not overwrite each other
  const to = `${file}.corrupt-${at}`;
  try { fs.renameSync(file, to); log.error('state unreadable, moved aside, starting fresh', { file, to, err: String(e) }); }
  catch (re) { log.error('state unreadable and could not be moved aside, starting fresh', { file, err: String(e), renameErr: String(re) }); return undefined; }
  try { fs.chmodSync(to, PRIVATE); } catch (ce) { log.warn('could not make the unreadable state copy private', { to, err: String(ce) }); }
  const dir = path.dirname(file);
  try {
    for (const old of staleCorruptCopies(fs.readdirSync(dir), path.basename(file))) { fs.rmSync(path.join(dir, old), { force: true }); log.info('removed an old unreadable state copy', { file: old }); }
  } catch (pe) { log.warn('could not prune old unreadable state copies', { dir, err: String(pe) }); }
  return to;
}

/** The `<base>.corrupt-<epoch ms>` names in a folder listing beyond the newest `keep`, oldest last. Anything else is never touched. */
export function staleCorruptCopies(names: string[], base: string, keep = KEEP_CORRUPT): string[] {
  const prefix = `${base}.corrupt-`;
  return names.filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length))).slice(keep);
}

export function getState(): State { return state; }

/** Changes within this window share one write. */
export const FLUSH_MS = 500;

export function update(fn: (s: State) => void): State {
  fn(state);
  dirty = true;
  if (!timer) timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  return state;
}

/**
 * Atomic: write tmp, fsync, then rename, so a crash never leaves a torn state.json. A failed write (disk full) stays dirty
 * for the next save. Writes to the file last loaded unless told otherwise. Compact JSON: this runs about every 10 s per
 * viewer and per cast, and indenting made a real state 28 percent bigger.
 */
export function flush(file = stateFile): void {
  if (!dirty) return;
  dirty = false;
  try { writeAtomic(file, JSON.stringify(state)); } catch (e) {
    dirty = true;
    log.error('state write failed, will retry on the next change', { file, err: String(e) });
  }
}

/**
 * Write tmp, fsync, rename. The tmp is PRIVATE whatever the umask, a tmp a crash left behind too, so every save keeps
 * the file private (a chmod 600 by hand is no longer undone by the next save, and an older 0644 file is tightened). Throws.
 */
export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(tmp, 'w', PRIVATE);
  try { fs.fchmodSync(fd, PRIVATE); fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export function flushSync(): void { if (timer) { clearTimeout(timer); timer = null; } flush(); }

// helpers
// State maps are plain objects: a key that is not isSafeKey is ignored, and reads see own keys only.
export function saveProgress(p: Progress): void {
  if (!isSafeKey(p.videoId)) return;
  update((s) => { s.progress[p.videoId] = { ...(getProgress(p.videoId) || {}), ...p, updatedAt: Date.now() }; });
}
export function getProgress(videoId: string): Progress | undefined { return isSafeKey(videoId) && Object.hasOwn(state.progress, videoId) ? state.progress[videoId] : undefined; }
/** Remember the subtitle picked for a video (null = off), so the next play and the TV start with it. */
export function saveSubChoice(videoId: string, c: { subId: string | null; subLang?: string; subOffsetMs?: number }): void {
  const p = getProgress(videoId);
  if (!p) return;   // nothing watched yet; the first position save carries the choice along
  update((s) => { s.progress[videoId] = { ...p, subId: c.subId, subLang: c.subId ? c.subLang : undefined, subOffsetMs: c.subOffsetMs ?? p.subOffsetMs }; });
}
// The finished rule lives in taste.ts (pure, no imports) so taste can use it without importing the store.
export { isFinished, isMarkedWatched, FINISHED_SHARE } from './taste.js';
/** Below this a save is noise: the studio logo, a mis-tap. Same floor as the player's own saves. */
export const MIN_PROGRESS_SEC = 5;

const NUMS = ['season', 'episode', 'fileIdx', 'subOffsetMs'] as const;
const STRS = ['name', 'poster', 'background', 'infoHash', 'subLang'] as const;
/** A progress body as a player sends it, or a 400: pos and dur are finite seconds, type is movie or series. Null is absent. */
export function progressBody(raw: unknown): Partial<Progress> {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Progress must be an object');
  const b = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  for (const k of ['pos', 'dur'] as const) if (b[k] != null && !(finite(b[k]) && b[k] >= 0)) throw httpError(400, `${k} must be a number of seconds`);
  for (const k of NUMS) if (b[k] != null && !finite(b[k])) throw httpError(400, `${k} must be a number`);
  for (const k of STRS) if (b[k] != null && typeof b[k] !== 'string') throw httpError(400, `${k} must be text`);
  if (b.type != null && b.type !== 'movie' && b.type !== 'series') throw httpError(400, 'type must be movie or series');
  if (b.subId != null && typeof b.subId !== 'string') throw httpError(400, 'subId must be text or null');
  if (b.metaId != null && b.metaId !== '') safeKey(b.metaId, 'meta id');
  return b as Partial<Progress>;
}

/**
 * A player's save merged over what is stored. A position at the very start never replaces a real one (a player
 * that had not seeked yet, not you starting over), unless it is a mark as watched. subId null is "subtitles off"
 * and sticks; absent means the player has not settled on one and keeps the stored choice.
 */
export function mergeProgress(existing: Progress | undefined, body: Partial<Progress>, videoId: string, now: number): Progress {
  const { metaId, season, episode } = parseVideoId(videoId);
  const pos = body.pos != null && body.pos < MIN_PROGRESS_SEC && existing && existing.pos > body.pos && !isMarkedWatched(body) ? existing.pos : body.pos;
  return {
    videoId, metaId: body.metaId || existing?.metaId || metaId, type: body.type || existing?.type || (season != null ? 'series' : 'movie'),
    pos: pos ?? existing?.pos ?? 0, dur: body.dur ?? existing?.dur ?? 0, updatedAt: now,
    name: body.name || existing?.name || videoId, poster: body.poster || existing?.poster, background: body.background || existing?.background,
    season: body.season ?? existing?.season ?? season, episode: body.episode ?? existing?.episode ?? episode,
    infoHash: body.infoHash || existing?.infoHash, fileIdx: body.fileIdx ?? existing?.fileIdx,
    subId: body.subId !== undefined ? body.subId : existing?.subId, subLang: body.subId !== undefined ? body.subLang : existing?.subLang, subOffsetMs: body.subOffsetMs ?? existing?.subOffsetMs,
  };
}

export function continueWatching(limit = 20): Progress[] {
  // one entry per show (latest episode), movies individually; finished (>95%) hidden.
  // Anything you actually started counts: a minute in still means "I was watching this".
  const byMeta = new Map<string, Progress>();
  for (const p of Object.values(state.progress)) {
    if (isFinished(p) || p.pos < MIN_PROGRESS_SEC) continue;
    const cur = byMeta.get(p.metaId);
    if (!cur || cur.updatedAt < p.updatedAt) byMeta.set(p.metaId, p);
  }
  return [...byMeta.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * Shows whose latest episode you finished, newest first. Continue watching rolls these on to the next episode
 * (see /home) instead of dropping the show the moment the credits end. Shows with an unfinished episode are
 * already in continueWatching and are left out here, and so is an episode only marked watched by hand.
 */
export function finishedSeriesHeads(limit = 10): Progress[] {
  const latest = new Map<string, Progress>();
  for (const p of Object.values(state.progress)) {
    if (p.type !== 'series' || p.metaId.startsWith('magnet:')) continue;
    const cur = latest.get(p.metaId);
    if (!cur || cur.updatedAt < p.updatedAt) latest.set(p.metaId, p);
  }
  return [...latest.values()].filter((p) => isFinished(p) && !isMarkedWatched(p)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** A collapsed repeat moves the head's time at most once a minute: media status arrives every few seconds all day. */
export const CAST_HISTORY_TOUCH_MS = 60_000;
/** Record something playing on a receiver; consecutive repeats of the same title collapse. */
export function addCastHistory(deviceId: string, e: CastHistoryEntry, cap = CAST_HISTORY_CAP): boolean {
  if (!isSafeKey(deviceId)) return false;
  const list = castHistory(deviceId);
  const head = list[0];
  const now = Date.now();
  if (head && head.title === e.title && head.app === e.app && now - head.ts < 6 * 3600_000) {
    const link = !!e.kino && !head.kino;
    if (link || now - head.ts >= CAST_HISTORY_TOUCH_MS) update(() => { head.ts = now; if (link) head.kino = e.kino; });
    return false;
  }
  update((s) => { s.castHistory[deviceId] = [e, ...list].slice(0, cap); });
  return true;
}
export function castHistory(deviceId: string): CastHistoryEntry[] { return (isSafeKey(deviceId) && Object.hasOwn(state.castHistory, deviceId) && state.castHistory[deviceId]) || []; }
