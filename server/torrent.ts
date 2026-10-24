import fs from 'node:fs';
import path from 'node:path';
import WebTorrent, { type Torrent, type TorrentFile } from 'webtorrent';
import { CACHE_DIR } from './config.js';
import { logger, errMsg } from './log.js';
import { httpError } from './errors.js';
import { getState, update, type CacheEntry } from './store.js';
import { dirSize, guard } from './disk.js';
import { emit } from './events.js';
import type { TorrentFileInfo, TorrentStats } from './types.js';

const log = logger('torrent');

export const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://opentracker.io:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
];

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv)$/i;
const isVideo = (name: string): boolean => VIDEO_EXT.test(name) && !/sample/i.test(name);

export const IDLE_MS = 10 * 60_000;
const META_TIMEOUT_MS = 45_000;
/** A closed file keeps downloading this long: a seek, the next range request or a probe reopens it first. */
export const DESELECT_GRACE_MS = 30_000;

let client: WebTorrent | null = null;
const torrents = new Map<string, Torrent>();             // metadata known: files are listed
const pending = new Map<string, Promise<Torrent>>();     // added, still waiting for metadata
const loading = new Map<string, { t: Torrent; abort: (e: Error) => void }>();   // the torrent behind each pending add
const knownWaits = new Map<string, Set<() => void>>();   // hash -> whenKnown callers, woken when ensure() adds it
const refs = new Map<string, number>();        // `${hash}:${idx}` -> open streams
const transcoderRefs = new Map<string, number>();   // of those, the ones an HLS transcoder's ffmpeg holds (a parked one too)
const idleTimers = new Map<string, NodeJS.Timeout>();
const statsTimers = new Map<string, NodeJS.Timeout>();
const deselectTimers = new Map<string, NodeJS.Timeout>();   // `${hash}:${idx}` -> stop downloading a closed file
const openedAt = new Map<string, number>();   // `${hash}:${idx}` -> when it went from closed to open, in open order
let opens = 0;

function getClient(): WebTorrent {
  if (!client) {
    client = new WebTorrent({ maxConns: 80, utp: false, dht: true });
    client.on('error', (e: Error) => log.error('client error', { err: e.message }));
    log.info('webtorrent client started');
  }
  return client;
}

/** Torrents in the client, 0 before the first play. Never creates it: an idle /health poll must not start DHT or map router ports. */
export function activeTorrents(): number { return client?.torrents.length ?? 0; }

/** Tests only: a fake client, so no test ever joins a real swarm. */
export function setClientForTests(c: WebTorrent | null): void { client = c; }

/** A cache key: 40 lowercase hex. Anything else must never reach a path under CACHE_DIR (`../..` is the home directory). */
export const isInfoHash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 32 char base32 btih (older magnets) to the hex webtorrent reports, so maps, index keys and cache dirs all agree. */
export function base32ToHex(s: string): string {
  let bits = 0; let v = 0; let out = '';
  for (const c of s.toUpperCase()) {
    v = ((v << 5) | B32.indexOf(c)) & 0xffff; bits += 5;
    if (bits >= 8) { bits -= 8; out += ((v >>> bits) & 0xff).toString(16).padStart(2, '0'); }
  }
  return out;
}

export function infoHashOf(id: string): string | undefined {
  const m = id.match(/urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})/i) || id.match(/^([0-9a-fA-F]{40})$/);
  if (!m) return undefined;
  return m[1].length === 32 ? base32ToHex(m[1]) : m[1].toLowerCase();
}

function magnetFor(infoHash: string, extraTrackers: string[] = []): string {
  const tr = [...new Set([...extraTrackers, ...TRACKERS])].map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${tr}`;
}

/** lastUsed only orders the LRU: a bump within this long of the previous one is not worth a state write (every seek is a range request). */
export const USED_RESOLUTION_MS = 60_000;

/** Someone used this torrent now: the LRU clock. */
function markUsed(infoHash: string, name?: string): void {
  const cur = getState().cacheIndex[infoHash];
  if (cur && (!name || cur.name === name) && Math.abs(Date.now() - cur.lastUsed) < USED_RESOLUTION_MS) return;
  update((s) => {
    const e = s.cacheIndex[infoHash] || { infoHash, name: name || infoHash, bytes: 0, lastUsed: 0 };
    e.lastUsed = Date.now();
    if (name) e.name = name;
    s.cacheIndex[infoHash] = e;
  });
}

/** Bytes on disk. Not a use (lastUsed stays), and no state write when nothing changed. */
function setBytes(infoHash: string, bytes: number, name?: string): void {
  const e = getState().cacheIndex[infoHash];
  if (e && e.bytes === bytes && (!name || e.name === name)) return;
  update((s) => {
    const x = s.cacheIndex[infoHash] || { infoHash, name: name || infoHash, bytes: 0, lastUsed: Date.now() };
    x.bytes = bytes;
    if (name) x.name = name;
    s.cacheIndex[infoHash] = x;
  });
}

/** Unload after IDLE_MS unless a file opens first (openFile cancels it). Also covers torrents only inspected, never played. */
function armIdle(infoHash: string): void {
  clearTimeout(idleTimers.get(infoHash));
  const timer = setTimeout(() => { idleTimers.delete(infoHash); if (!isActive(infoHash)) unload(infoHash); }, IDLE_MS);
  timer.unref();
  idleTimers.set(infoHash, timer);
}

/** Drop every ref and timer for a hash (unloaded or removed). */
function forget(infoHash: string): void {
  for (const k of [...refs.keys()]) if (k.startsWith(`${infoHash}:`)) refs.delete(k);
  for (const k of [...transcoderRefs.keys()]) if (k.startsWith(`${infoHash}:`)) transcoderRefs.delete(k);
  for (const [k, timer] of deselectTimers) if (k.startsWith(`${infoHash}:`)) { clearTimeout(timer); deselectTimers.delete(k); }
  for (const k of [...openedAt.keys()]) if (k.startsWith(`${infoHash}:`)) openedAt.delete(k);
  clearTimeout(idleTimers.get(infoHash)); idleTimers.delete(infoHash);
  clearInterval(statsTimers.get(infoHash)); statsTimers.delete(infoHash);
}

/**
 * Add (or reuse) a torrent and wait for metadata. Never downloads until a file is opened. A torrent only
 * enters `torrents` once its files are known: a second caller during the wait shares the same promise
 * instead of getting a torrent with no files (the Player fires /api/play and /api/subs together).
 */
export async function ensure(id: string): Promise<Torrent> {
  const infoHash = infoHashOf(id);
  if (!infoHash) throw httpError(400, 'Not a valid magnet link or info hash');
  const inflight = pending.get(infoHash);
  if (inflight) return inflight;
  const existing = torrents.get(infoHash);
  if (existing && !existing.destroyed) { markUsed(infoHash); if (!isActive(infoHash)) armIdle(infoHash); return existing; }

  guard();
  const p = new Promise<Torrent>((resolve, reject) => {
    const magnet = id.startsWith('magnet:') ? id : magnetFor(infoHash);
    const dir = path.join(CACHE_DIR, infoHash);
    log.info('adding', { infoHash });
    const t = getClient().add(magnet, { path: dir, deselect: true, announce: TRACKERS, strategy: 'sequential' });
    t.setMaxListeners(100);   // every range request, probe and subtitle read adds a stream listener
    const abort = (e: Error) => { clearTimeout(timer); t.destroy({ destroyStore: false }); reject(e); };
    const timer = setTimeout(() => {
      log.warn('metadata timeout', { infoHash });
      abort(httpError(404, 'No peers found for this torrent (metadata timeout). Try another source.', 'no-peers'));
    }, META_TIMEOUT_MS);
    loading.set(infoHash, { t, abort });
    t.once('error', (e: Error) => { clearTimeout(timer); if (torrents.get(infoHash) === t) { torrents.delete(infoHash); forget(infoHash); } reject(e); });
    t.once('metadata', () => {
      clearTimeout(timer);
      // deselect everything explicitly (belt and braces): a season pack must not download whole
      for (const f of t.files) f.deselect();
      torrents.set(infoHash, t);
      markUsed(infoHash, t.name);
      if (!isActive(infoHash)) armIdle(infoHash);
      log.info('metadata', { infoHash, name: t.name, files: t.files.length, length: t.length });
      resolve(t);
    });
    t.on('warning', (w: Error) => log.debug('warning', { infoHash, w: w.message }));
  }).finally(() => { if (pending.get(infoHash) === p) { pending.delete(infoHash); loading.delete(infoHash); } });
  pending.set(infoHash, p);
  for (const wake of [...(knownWaits.get(infoHash) ?? [])]) wake();
  return p;
}

export function listFiles(t: Torrent): TorrentFileInfo[] {
  return t.files.map((f, index) => ({ index, name: f.name, path: f.path, length: f.length, isVideo: isVideo(f.name) }));
}

/** Largest video file, used when a source has no fileIdx. */
export function pickVideoFile(t: Torrent, fileIdx?: number): number {
  if (fileIdx != null && t.files[fileIdx]) return fileIdx;
  let best = -1; let size = -1;
  t.files.forEach((f, i) => { if (isVideo(f.name) && f.length > size) { best = i; size = f.length; } });
  if (best < 0) t.files.forEach((f, i) => { if (f.length > size) { best = i; size = f.length; } });
  return best;
}

/** On the downloads list (play later), finished or not. */
export function isDownload(h: string): boolean { return Object.values(getState().downloads || {}).some((d) => d.infoHash === h); }

/**
 * A hash Kino already chose: loading or loaded now, in the cache index (kept across a restart, so a TV that
 * resumes a stream still finds it) or a download. /api/file is open without the PIN, so only these may start a torrent.
 */
export function isKnown(infoHash: string): boolean {
  const h = infoHash.toLowerCase();
  if (!isInfoHash(h)) return false;
  const s = getState();
  return torrents.has(h) || pending.has(h) || Object.hasOwn(s.cacheIndex, h) || isDownload(h);
}

/**
 * True as soon as `infoHash` is known: now, or the moment ensure() starts loading it. After `ms` without that, whatever
 * isKnown says then (a cache index or download entry is only checked at the end). The player asks for subtitles
 * in the same breath as its POST /api/play, so a GET can arrive a moment before the hash it names.
 */
export function whenKnown(infoHash: string, ms: number): Promise<boolean> {
  const h = infoHash.toLowerCase();
  if (isKnown(h)) return Promise.resolve(true);
  if (!isInfoHash(h) || !(ms > 0)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const waits = knownWaits.get(h) ?? new Set(); knownWaits.set(h, waits);
    const wake = () => { clearTimeout(timer); waits.delete(wake); if (!waits.size) knownWaits.delete(h); resolve(isKnown(h)); };
    const timer = setTimeout(wake, ms);
    waits.add(wake);
  });
}

/** A loaded torrent whose files are known, or undefined (never one still waiting for metadata). */
export function getTorrent(infoHash: string): Torrent | undefined {
  const t = torrents.get(infoHash.toLowerCase());
  return t && !t.destroyed && t.files.length ? t : undefined;
}

/** The file a torrent's live stats describe: of its files open now, the one opened last (auto-next overlaps two episodes). */
function statsFile(infoHash: string): number | undefined {
  let idx: number | undefined; let at = -1;
  for (const k of refs.keys()) {
    const n = openedAt.get(k) ?? 0;
    if (k.startsWith(`${infoHash}:`) && n > at) { at = n; idx = Number(k.slice(41)); }
  }
  return idx;
}

/**
 * Who reads a file: a player, TV, probe or download hold (`viewer`), or an HLS session's ffmpeg (`transcoder`).
 * /health counts a transcoder as its session, not as a stream: a parked one (SIGSTOP) keeps its read open and watches nothing.
 */
export type Reader = 'viewer' | 'transcoder';

const bump = (m: Map<string, number>, key: string, by: number) => { const n = (m.get(key) || 0) + by; if (n > 0) m.set(key, n); else m.delete(key); };

/** Mark a file as in use: select it, cancel idle unload, start stats ticker. */
export function openFile(t: Torrent, idx: number, reader: Reader = 'viewer'): TorrentFile {
  const f = t.files[idx];
  if (!f) throw new Error(`file ${idx} not in torrent`);
  const key = `${t.infoHash}:${idx}`;
  const n = refs.get(key) || 0;
  refs.set(key, n + 1);
  if (reader === 'transcoder') bump(transcoderRefs, key, 1);
  if (!n) openedAt.set(key, ++opens);
  const it = idleTimers.get(t.infoHash);
  if (it) { clearTimeout(it); idleTimers.delete(t.infoHash); }
  clearTimeout(deselectTimers.get(key)); deselectTimers.delete(key);
  f.select();
  markUsed(t.infoHash, t.name);
  if (!statsTimers.has(t.infoHash)) {
    statsTimers.set(t.infoHash, setInterval(() => { try { emit('torrent.stats', stats(t.infoHash, statsFile(t.infoHash))); } catch { /* gone */ } }, 2000));
  }
  return f;
}

export function closeFile(t: Torrent, idx: number, reader: Reader = 'viewer'): void {
  if (torrents.get(t.infoHash) !== t) return;   // unloaded or removed meanwhile: its refs are gone, do not touch a newer load's
  const key = `${t.infoHash}:${idx}`;
  if (reader === 'transcoder') bump(transcoderRefs, key, -1);
  const n = (refs.get(key) || 1) - 1;
  if (n > 0) { refs.set(key, n); return; }
  refs.delete(key); openedAt.delete(key);
  scheduleDeselect(t, idx);
  const anyOpen = [...refs.keys()].some((k) => k.startsWith(t.infoHash));
  if (anyOpen) return;
  const st = statsTimers.get(t.infoHash);
  if (st) { clearInterval(st); statsTimers.delete(t.infoHash); }
  markUsed(t.infoHash);   // used until now (a long HLS read opens once)
  armIdle(t.infoHash);
}

/**
 * Nobody reads this file any more (a download hold counts as a reader): stop fetching it after a grace period,
 * so a season pack with auto-next does not keep every watched episode downloading. Complete files stay as they are.
 */
function scheduleDeselect(t: Torrent, idx: number): void {
  const key = `${t.infoHash}:${idx}`;
  clearTimeout(deselectTimers.get(key));
  const timer = setTimeout(() => {
    deselectTimers.delete(key);
    const f = t.files[idx];
    if (refs.has(key) || t.destroyed || !f || f.progress >= 1) return;
    f.deselect();
    // a deselect also trims a boundary piece shared with a neighbour: select the files still open again
    for (const k of refs.keys()) if (k.startsWith(`${t.infoHash}:`)) t.files[Number(k.slice(41))]?.select();
    log.info('deselected', { infoHash: t.infoHash, idx, name: f.name });
  }, DESELECT_GRACE_MS);
  timer.unref();
  deselectTimers.set(key, timer);
}

/** Open file streams right now (players, ffmpeg, TVs pulling bytes). */
export function openStreams(): number { return [...refs.values()].reduce((a, n) => a + n, 0); }
/** Of openStreams, the ones HLS transcoders hold (openFile with `transcoder`). */
export function transcoderStreams(): number { return [...transcoderRefs.values()].reduce((a, n) => a + n, 0); }

export function isActive(infoHash: string): boolean {
  return [...refs.keys()].some((k) => k.startsWith(infoHash));
}

/** Drop from the client (keeps files on disk). */
function unload(infoHash: string): void {
  const t = torrents.get(infoHash);
  forget(infoHash);
  if (!t) return;
  const bytes = dirSize(path.join(CACHE_DIR, infoHash));
  setBytes(infoHash, bytes, t.name);
  torrents.delete(infoHash);
  t.destroy({ destroyStore: false }, () => log.info('unloaded (idle)', { infoHash, bytes }));
  void evict();
}

export function stats(infoHash: string, idx?: number): TorrentStats {
  const t = getTorrent(infoHash) ?? loading.get(infoHash.toLowerCase())?.t;   // peers while metadata loads
  if (!t) return { infoHash, numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0, downloaded: 0, length: 0, ready: false };
  const f = idx != null ? t.files[idx] : undefined;
  return {
    infoHash, numPeers: t.numPeers, downloadSpeed: t.downloadSpeed, uploadSpeed: t.uploadSpeed,
    progress: f ? f.progress : t.progress, downloaded: f ? f.downloaded : t.downloaded, length: f ? f.length : t.length || 0, ready: t.ready,
  };
}

/** Remove a torrent and its data. Throws (400) on anything but a hex info hash: the name becomes an rm -rf path. */
export async function remove(infoHash: string): Promise<void> {
  if (!isInfoHash(infoHash)) throw Object.assign(new Error('Not an info hash'), { status: 400 });
  loading.get(infoHash)?.abort(new Error('Removed from the cache'));
  forget(infoHash);
  const t = torrents.get(infoHash);
  if (t) { torrents.delete(infoHash); await new Promise<void>((r) => t.destroy({ destroyStore: true }, () => r())); }
  fs.rmSync(path.join(CACHE_DIR, infoHash), { recursive: true, force: true });
  update((s) => { delete s.cacheIndex[infoHash]; });
  log.info('removed', { infoHash });
}

export function cacheTotal(): number {
  return Object.values(getState().cacheIndex).reduce((a, e) => a + e.bytes, 0);
}

/**
 * Which cache entries to drop, least recently used first, until the total fits the cap. Kept ones (playing, loading,
 * downloaded for later) are skipped but still count.
 */
export function planEviction(entries: CacheEntry[], cap: number, keep: (infoHash: string) => boolean): string[] {
  let total = entries.reduce((a, e) => a + e.bytes, 0);
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= cap) break;
    if (keep(e.infoHash)) continue;
    out.push(e.infoHash);
    total -= e.bytes;
  }
  return out;
}

/**
 * Never evicted or cleared: open now, still loading, or a download for later. A finished download has no file open,
 * so only its entry in the downloads list says it must stay.
 */
function isKept(infoHash: string): boolean { return isActive(infoHash) || pending.has(infoHash) || isDownload(infoHash); }

let evicting: Promise<unknown> = Promise.resolve();
/** Removals run one at a time (idle unloads, settings, boot and "Clear all" all ask for them). */
function queue(run: () => Promise<string[]>): Promise<string[]> {
  const p = evicting.then(run, run);
  evicting = p;
  return p;
}

/** Remove these entries in turn, skipping one kept by the time its turn comes (opened or downloaded meanwhile). */
async function removeUnkept(hashes: string[], why: string): Promise<string[]> {
  const removed: string[] = [];
  for (const h of hashes) {
    if (isKept(h)) continue;
    try { await remove(h); removed.push(h); } catch (e) { log.warn(`${why} failed`, { infoHash: h, err: errMsg(e) }); }
  }
  return removed;
}

/** LRU eviction down to the cap. Kept torrents (`isKept`) are never touched. */
export function evict(): Promise<string[]> {
  return queue(async () => {
    const s = getState();
    const removed = await removeUnkept(planEviction(Object.values(s.cacheIndex), s.settings.cacheCapBytes, isKept), 'evict');
    if (removed.length) log.info('evicted', { removed, totalAfter: cacheTotal() });
    return removed;
  });
}

/** Settings, "Clear all cached data": every cache entry but the kept ones, so downloads saved for later stay. */
export function clearAll(): Promise<string[]> {
  return queue(async () => {
    const removed = await removeUnkept(Object.keys(getState().cacheIndex), 'clear');
    log.info('cache cleared', { removed: removed.length, kept: Object.keys(getState().cacheIndex).length });
    return removed;
  });
}

/** Reconcile index with what is on disk (called at boot). */
export function reconcile(): void {
  const onDisk = new Set<string>();
  for (const d of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !isInfoHash(d.name)) continue;
    onDisk.add(d.name);
    const p = path.join(CACHE_DIR, d.name);
    const bytes = dirSize(p);
    update((s) => {
      const e = s.cacheIndex[d.name] || { infoHash: d.name, name: d.name, bytes: 0, lastUsed: fs.statSync(p).mtimeMs };
      e.bytes = bytes; s.cacheIndex[d.name] = e;
    });
  }
  update((s) => { for (const k of Object.keys(s.cacheIndex)) if (!onDisk.has(k)) delete s.cacheIndex[k]; });
  log.info('cache reconciled', { entries: onDisk.size, bytes: cacheTotal() });
  void evict();
}

/** Refresh byte counts of loaded torrents (cheap: torrent.downloaded). */
export function refreshSizes(): void {
  for (const [hash, t] of torrents) if (!t.destroyed) setBytes(hash, Math.max(t.downloaded, getState().cacheIndex[hash]?.bytes || 0), t.name);
}

type PmpClient = { _reqActive?: boolean; close?: () => Promise<unknown> };
/**
 * Called on the client's NAT traversal (nat-api) before destroy. Its destroy unmaps each port it mapped (torrent and
 * DHT) over NAT-PMP first, 1 s timeout each, then UPnP. Its NAT-PMP client never gives up on a request: on a router
 * that ignored the first, every later one queues behind it unsent, so each unmap waits out its second for nothing
 * (2 of the 2.2 s a shutdown took here). With a request still unanswered, close NAT-PMP: the unmaps go to UPnP at once.
 * True when it did. Reads nat-api internals; a version without them gets the slow path, nothing worse.
 */
export function dropStuckPmp(nat: unknown): boolean {
  const n = nat as { _pmpClient?: PmpClient | null } | null | undefined;
  const pmp = n?._pmpClient;
  if (!n || !pmp?._reqActive) return false;
  n._pmpClient = null;
  void pmp.close?.().catch(() => undefined);
  return true;
}

export async function shutdown(): Promise<void> {
  refreshSizes();
  if (!client) return;
  if (dropStuckPmp((client as unknown as { natTraversal?: unknown }).natTraversal)) log.debug('NAT-PMP never answered: ports unmapped over UPnP only');
  await new Promise<void>((r) => client!.destroy(() => r()));
  log.info('client destroyed');
}
