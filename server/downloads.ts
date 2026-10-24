import { logger, errMsg } from './log.js';
import { getState, update } from './store.js';
import { emit, send, onClientConnect, clientCount } from './events.js';
import { ensure, pickVideoFile, getTorrent, openFile, closeFile } from './torrent.js';
import { guard } from './disk.js';
import type { Download, DownloadInfo, MediaType } from './types.js';

const log = logger('downloads');

// "Download and play later": for titles with too few seeds to stream, keep the
// file selected until it is complete, then hand it to the normal player (the
// cache already holds it, so playback is instant and offline). Held files are
// active in the torrent module's eyes, so LRU never evicts a half download.

const active = new Map<string, { infoHash: string; idx: number }>();   // key -> held file
let ticker: NodeJS.Timeout | null = null;
let pubTimer: NodeJS.Timeout | null = null;

const key = (infoHash: string, idx: number) => `${infoHash}:${idx}`;

/** Files currently held open for a background download (not a viewer). */
export function heldCount(): number { return active.size; }

export function list(): DownloadInfo[] {
  const out: DownloadInfo[] = [];
  for (const d of Object.values(getState().downloads || {})) {
    const t = getTorrent(d.infoHash);
    const f = t?.files[d.fileIdx];
    out.push({ ...d, progress: d.done ? 1 : f ? f.progress : 0, downloaded: d.done ? d.sizeBytes : f ? f.downloaded : 0, speed: t && !d.done ? t.downloadSpeed : 0, peers: t && !d.done ? t.numPeers : 0, active: active.has(key(d.infoHash, d.fileIdx)) });
  }
  return out.sort((a, b) => Number(a.done) - Number(b.done) || b.addedAt - a.addedAt);
}

function publish(): void {
  if (pubTimer) return;
  pubTimer = setTimeout(() => { pubTimer = null; if (clientCount()) emit('downloads', list()); }, 200);
}

function tick(): void {
  let anyPending = false;
  for (const [k, a] of active) {
    const d = getState().downloads[k];
    const t = getTorrent(a.infoHash);
    const f = t?.files[a.idx];
    if (!d) { release(k); continue; }
    if (!t || !f) { // torrent got unloaded from under us: re-hold
      active.delete(k); void hold(d); continue;
    }
    if (f.progress >= 1) {
      update((s) => { const x = s.downloads[k]; if (x) { x.done = true; x.doneAt = Date.now(); x.error = undefined; } });
      log.info('complete', { name: d.name });
      release(k);
      continue;
    }
    anyPending = true;
  }
  publish();
  if (!anyPending && ticker) { clearInterval(ticker); ticker = null; }
}

function release(k: string): void {
  const a = active.get(k);
  active.delete(k);
  if (!a) return;
  const t = getTorrent(a.infoHash);
  if (t) closeFile(t, a.idx);
}

async function hold(d: Download): Promise<void> {
  const k = key(d.infoHash, d.fileIdx);
  if (active.has(k)) return;
  active.set(k, { infoHash: d.infoHash, idx: d.fileIdx });
  try {
    const t = await ensure(d.infoHash);
    if (!active.has(k)) return;
    const f = t.files[d.fileIdx];
    if (!f) throw new Error('file missing from torrent');
    openFile(t, d.fileIdx);
    update((s) => { const x = s.downloads[k]; if (x) { x.error = undefined; x.sizeBytes = f.length; if (!x.name || x.name === x.infoHash) x.name = f.name; } });
    if (!ticker) { ticker = setInterval(tick, 3000); ticker.unref(); }
  } catch (e) {
    active.delete(k);
    update((s) => { const x = s.downloads[k]; if (x) x.error = errMsg(e); });
    log.warn('hold failed', { name: d.name, err: errMsg(e) });
  }
  publish();
}

export async function add(req: { infoHash: string; fileIdx?: number; videoId?: string; metaId?: string; type?: MediaType; name?: string; poster?: string; background?: string }): Promise<DownloadInfo[]> {
  guard();
  const t = await ensure(req.infoHash);
  const idx = pickVideoFile(t, req.fileIdx != null && req.fileIdx >= 0 ? req.fileIdx : undefined);
  if (idx < 0) throw Object.assign(new Error('No video file in this torrent'), { status: 400 });
  const f = t.files[idx];
  const k = key(t.infoHash, idx);
  const d: Download = {
    key: k, infoHash: t.infoHash, fileIdx: idx, videoId: req.videoId, metaId: req.metaId, type: req.type || (req.videoId?.includes(':') ? 'series' : 'movie'),
    name: req.name || f.name, poster: req.poster, background: req.background, sizeBytes: f.length, addedAt: Date.now(), done: f.progress >= 1, doneAt: f.progress >= 1 ? Date.now() : undefined,
  };
  update((s) => { s.downloads[k] = { ...(s.downloads[k] || {}), ...d, addedAt: s.downloads[k]?.addedAt || d.addedAt }; });
  log.info('queued', { name: d.name, size: f.length, done: d.done });
  if (!d.done) await hold(d);
  publish();
  return list();
}

export async function remove(k: string): Promise<DownloadInfo[]> {
  release(k);
  update((s) => { delete s.downloads[k]; });
  publish();
  return list();
}

/** Boot: pick up unfinished downloads. */
export function start(): void {
  onClientConnect((res) => send(res, 'downloads', list()));
  const pending = Object.values(getState().downloads || {}).filter((d) => !d.done);
  if (!pending.length) return;
  log.info('resuming', { count: pending.length });
  // Stagger so six torrents do not fight for peers at once.
  pending.forEach((d, i) => setTimeout(() => void hold(d), 3000 + i * 4000).unref());
}

export function stop(): void {
  if (ticker) clearInterval(ticker);
  for (const k of [...active.keys()]) release(k);
}
