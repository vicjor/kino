import { httpError } from '../errors.js';
import * as cast from '../cast/manager.js';
import * as monitor from '../cast/monitor.js';
import * as upnext from '../cast/upnext.js';
import * as discovery from '../cast/discovery.js';
import * as dlna from '../cast/dlna.js';
import { apiRouter, optKey, wholeIndex, finiteMs } from './util.js';
import type { CastPlayRequest } from '../types.js';

/** Casting to Chromecasts and DLNA TVs, and every Cast receiver on the LAN. */
export const api = apiRouter();

/** A required text field of a request body, or a 400. */
const text = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v.trim()) throw httpError(400, `${what} required`); return v; };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Where to seek, from a request body: finite seconds from 0, or a 400. A missing or garbled time used to seek the TV back to the start. */
export function seekTime(v: unknown): number {
  if (!finite(v) || v < 0) throw httpError(400, 'time must be a number of seconds from 0');
  return v;
}
/** A volume change from a request body: level a finite number kept within 0 to 1, muted true or false, at least one of them. Or a 400. */
export function volumeChange(b: unknown): { level?: number; muted?: boolean } {
  const { level, muted } = (b && typeof b === 'object' ? b : {}) as { level?: unknown; muted?: unknown };
  if (level != null && !finite(level)) throw httpError(400, 'level must be a number from 0 to 1');
  if (muted != null && typeof muted !== 'boolean') throw httpError(400, 'muted must be true or false');
  if (level == null && muted == null) throw httpError(400, 'level or muted required');
  return { ...(level != null ? { level: Math.min(1, Math.max(0, level)) } : {}), ...(muted != null ? { muted } : {}) };
}

api.get('/cast/devices', (req, res) => { if (req.query.refresh) discovery.refresh(); res.json(discovery.list()); });
api.get('/cast/status', (_req, res) => res.json(cast.status()));
api.post('/cast/play', async (req, res) => {
  const b = (req.body || {}) as CastPlayRequest;
  text(b.deviceId, 'deviceId'); text(b.infoHash, 'infoHash'); optKey(b.videoId, 'video id');
  if (b.startTime != null && !(finite(b.startTime) && b.startTime >= 0)) throw httpError(400, 'startTime must be a number of seconds');
  res.json(await cast.castTo(b));
});
api.post('/cast/pause', async (_req, res) => { await cast.pause(); res.json(cast.status()); });
api.post('/cast/resume', async (_req, res) => { await cast.resume(); res.json(cast.status()); });
api.post('/cast/next', async (_req, res) => { res.json(await cast.castNext()); });
// Another release of what is casting: same device, same position, same subtitle language.
api.post('/cast/source', async (req, res) => {
  const infoHash = String(req.body?.infoHash || ''); const fileIdx: unknown = req.body?.fileIdx;
  if (!infoHash) throw httpError(400, 'infoHash required');
  if (fileIdx != null && !wholeIndex(fileIdx)) throw httpError(400, 'fileIdx must be a whole number');
  res.json(await cast.switchSource(infoHash, (fileIdx ?? undefined) as number | undefined));
});
// Up next: { cancel: true } is "not now" / "stop after this episode", { cancel: false } turns auto-next back on for it.
api.post('/cast/upnext', async (req, res) => { if (req.body?.cancel === false) upnext.resume(); else upnext.cancel(); res.json(cast.status()); });
// The Chromecast fetches this when Kino activates the "Up next" track at the credits: subtitles plus a countdown.
api.get('/cast/upnext/:token.vtt', async (req, res) => {
  const vtt = await cast.upnextVtt(req.params.token as string);
  if (vtt == null) { res.status(404).end(); return; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(vtt);
});
api.post('/cast/stop', async (_req, res) => { await cast.stop(); res.json(cast.status()); });
api.post('/cast/seek', async (req, res) => { await cast.seek(seekTime(req.body?.time)); res.json(cast.status()); });
api.post('/cast/volume', async (req, res) => { await cast.setVolume(volumeChange(req.body)); res.json(cast.status()); });
// A string offset used to differ from the current one and restart the cast.
api.post('/cast/subtitle', async (req, res) => {
  const { subId = null, offsetMs } = (req.body || {}) as { subId?: unknown; offsetMs?: unknown };
  if (subId !== null && typeof subId !== 'string') throw httpError(400, 'subId must be a subtitle id or null');
  if (offsetMs != null && !finiteMs(offsetMs)) throw httpError(400, 'offsetMs must be a number of milliseconds');
  await cast.setSubtitle(subId, offsetMs ?? undefined); res.json(cast.status());
});
// Every Cast receiver on the LAN, with whatever anyone is playing on it (live via SSE too).
api.get('/cast/receivers', (req, res) => { if (req.query.refresh) monitor.refresh(); res.json(monitor.list()); });
api.get('/cast/receivers/:id/history', (req, res) => res.json(monitor.history(req.params.id as string)));
// The same body checks as Kino's own cast: an unchecked level reached setVolume as is, a NaN time reached seek.
api.post('/cast/receivers/:id/:cmd', async (req, res) => {
  const cmd = req.params.cmd as string;
  // The TV's power button, playing or not: on is Wake-on-LAN, off is an LG TV's own remote protocol.
  if (cmd === 'power') {
    const id = req.params.id as string;
    if (!dlna.isDlnaId(id)) { res.status(400).json({ error: 'Kino can turn only the LG TV on and off' }); return; }
    if (typeof req.body?.on !== 'boolean') { res.status(400).json({ error: 'Say on or off' }); return; }
    await dlna.power(id, req.body.on);
    res.json(dlna.receiverInfo(id) ?? null);
    return;
  }
  if (!['stop', 'pause', 'play', 'volume', 'seek'].includes(cmd)) { res.status(400).json({ error: 'unknown command' }); return; }
  const body = cmd === 'volume' ? volumeChange(req.body) : cmd === 'seek' ? { time: seekTime(req.body?.time) } : {};
  res.json(await monitor.command(req.params.id as string, cmd as 'stop' | 'pause' | 'play' | 'volume' | 'seek', body));
});
// Panic button: kills every running app on every cast device on the LAN, not just Kino's.
api.post('/cast/stop-all', async (_req, res) => { res.json(await monitor.stopAll()); });
api.get('/cast/stop-all', async (_req, res) => { res.json(await monitor.stopAll()); });
api.post('/cast/handoff', async (_req, res) => { res.json(await cast.handoff()); });
