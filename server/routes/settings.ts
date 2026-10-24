import { httpError } from '../errors.js';
import { sanitizeSettings, mergeBackup, isBackup } from '../settings.js';
import { getState, update, dismissRecovered } from '../store.js';
import * as addons from '../addons.js';
import * as torrent from '../torrent.js';
import * as downloads from '../downloads.js';
import { freeBytes, hlsBytes } from '../disk.js';
import { apiRouter } from './util.js';
import type { DiskInfo } from '../types.js';

/** Settings, addons, disk and cache, backup and restore. */
export const api = apiRouter();

api.get('/settings', (_req, res) => res.json(getState().settings));
// Every field goes through sanitizeSettings (settings.ts); one wrong field refuses the whole change, in words.
api.put('/settings', (req, res) => {
  const { settings, errors } = sanitizeSettings(req.body ?? {});
  if (errors.length) throw httpError(400, errors.join(' '));
  update((s) => { Object.assign(s.settings, settings); });
  void torrent.evict();
  res.json(getState().settings);
});
// Settings has said that the state file was unreadable and Kino started fresh, or that a load repaired or pruned it:
// /health stops saying so until the next time.
api.post('/recovered/dismiss', (_req, res) => { dismissRecovered(); res.json({ ok: true }); });
api.get('/addons', async (_req, res) => res.json(await addons.listAddons()));
api.get('/addons/catalog', async (_req, res) => res.json(await addons.catalog()));
api.post('/addons', async (req, res) => res.json(await addons.addAddon(String(req.body?.url || ''))));
api.delete('/addons', (req, res) => { addons.removeAddon(String(req.query.url || '')); res.json({ ok: true }); });

/**
 * DiskInfo plus the downloads saved for later: their bytes (part of cacheBytes) and which entries they are. They count
 * toward the cache limit but are never evicted or cleared, so on their own they can pass it. Older clients ignore both.
 */
type DiskReport = Omit<DiskInfo, 'entries'> & { downloadBytes: number; entries: (DiskInfo['entries'][number] & { download: boolean })[] };
async function diskInfo(): Promise<DiskReport> {
  const hls = await hlsBytes();   // walked off the request thread, before the rest so all of it is read at one moment
  const { free, total } = freeBytes();
  const s = getState();
  const entries = Object.values(s.cacheIndex).sort((a, b) => b.lastUsed - a.lastUsed)
    .map((e) => ({ infoHash: e.infoHash, name: e.name, bytes: e.bytes, lastUsed: e.lastUsed, active: torrent.isActive(e.infoHash), download: torrent.isDownload(e.infoHash) }));
  return {
    freeBytes: free, totalBytes: total, cacheBytes: torrent.cacheTotal(), cacheCapBytes: s.settings.cacheCapBytes, hlsBytes: hls,
    downloadBytes: entries.reduce((a, e) => a + (e.download ? e.bytes : 0), 0), entries,
  };
}
api.get('/disk', async (_req, res) => { torrent.refreshSizes(); res.json(await diskInfo()); });
// One entry goes even when it is a download for later (you asked for that one, Settings asks first), and leaves the
// downloads list with its files, so Library never offers a finished download that is gone. All of them skips what is
// playing, loading or saved for later, like eviction does.
api.post('/cache/clear', async (req, res) => {
  const h: unknown = req.body?.infoHash;
  if (h) {
    if (!torrent.isInfoHash(h)) { res.status(400).json({ error: 'Not an info hash' }); return; }
    if (torrent.isActive(h)) { res.status(409).json({ error: 'That is playing right now. Stop it first.' }); return; }
    await torrent.remove(h);
    for (const d of Object.values(getState().downloads)) if (d.infoHash === h) await downloads.remove(d.key);
  } else await torrent.clearAll();
  res.json(await diskInfo());
});

// Backup: the whole state file (progress, watchlist, settings, downloads). Restore merges settings and
// progress in, so moving to a new Mac is one download and one upload.
api.get('/backup', (_req, res) => { res.setHeader('Content-Disposition', `attachment; filename="kino-backup-${new Date().toISOString().slice(0, 10)}.json"`); res.json(getState()); });
api.post('/restore', (req, res) => {
  const b: unknown = req.body;
  if (!isBackup(b)) { res.status(400).json({ error: 'That is not a Kino backup' }); return; }
  update((s) => { mergeBackup(s, b); });
  res.json({ ok: true, progress: Object.keys(getState().progress).length, watchlist: getState().watchlist.length });
});
