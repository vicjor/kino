import path from 'node:path';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { httpError } from '../errors.js';
import { getState } from '../store.js';
import * as torrent from '../torrent.js';
import { guard } from '../disk.js';
import { serveFile, localFileUrl } from '../media/range.js';
import { probe, probeFailure } from '../media/probe.js';
import { decide, pickAudio } from '../media/decide.js';
import * as hls from '../media/hls.js';
import * as downloads from '../downloads.js';
import * as picks from '../picks.js';
import { apiRouter, log, target, knownHash, wholeIndex } from './util.js';
import type { PlayRequest, PlayResponse } from '../types.js';

/** Starting playback, the raw file, HLS sessions, torrents and downloads. */
export const api = apiRouter();

const clientKey = (req: Request) => crypto.createHash('sha1').update(`${req.ip}|${req.headers['user-agent'] || ''}`).digest('hex').slice(0, 12);

/** An optional index from a request body (fileIdx, audioTrack): absent or null leaves the pick to Kino, else a whole number from 0, or a 400. */
export function optIndex(v: unknown, what: string): number | undefined {
  if (v == null) return undefined;
  if (!wholeIndex(v)) throw httpError(400, `${what} must be a whole number from 0`);
  return v;
}

/** How far before the probed end a seek may start: ffmpeg -ss at the very end makes no segment and the player waits for nothing. */
export const SEEK_END_MARGIN_S = 5;
/** Where an HLS seek starts: a finite number of seconds, from 0, at most the probed duration less the margin when the probe knows it. Or a 400. */
export function hlsSeekTime(v: unknown, duration?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw httpError(400, 'time must be a number of seconds');
  const end = duration != null && Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - SEEK_END_MARGIN_S) : Infinity;
  return Math.min(Math.max(0, v), end);
}

api.post('/play', async (req, res) => {
  const body = (req.body || {}) as PlayRequest;
  const id = body.magnet || body.infoHash;
  if (!id) throw httpError(400, 'infoHash or magnet required');
  const fileIdx = optIndex(body.fileIdx, 'fileIdx'), audioTrack = optIndex(body.audioTrack, 'audioTrack');
  guard();
  const t = await torrent.ensure(id);
  const idx = torrent.pickVideoFile(t, fileIdx);
  if (idx < 0) throw httpError(400, 'No video file in this torrent');
  const f = t.files[idx];
  const key = `${t.infoHash}:${idx}`;
  const local = localFileUrl(t.infoHash, idx);
  const tg = target(body.target);
  let p;
  try { p = await probe(key, local); }
  catch (e) { throw probeFailure(e); }   // a local ffprobe that cannot start is not a slow torrent
  const audioIndex = pickAudio(p, audioTrack, ['eng', ...getState().settings.subLangs]);
  const d = decide(p, tg, { forceHls: body.forceHls, audioIndex, caps: body.caps, hdr: p.hdr });
  const out: PlayResponse = { mode: d.mode, url: `/api/file/${t.infoHash}/${idx}`, infoHash: t.infoHash, fileIdx: idx, fileName: f.name, sizeBytes: f.length, probe: p, audioIndex: d.audioIndex, reason: d.reason };
  if (d.mode !== 'direct') {
    const s = hls.start({ infoHash: t.infoHash, fileIdx: idx, sourceUrl: local, startOffset: 0, decision: d, probe: p, owner: clientKey(req) });
    out.url = `/api/hls/${s.id}/index.m3u8`; out.sessionId = s.id;
  }
  log.info('play', { infoHash: t.infoHash, idx, file: f.name, target: tg, mode: d.mode, reason: d.reason });
  res.json(out);
});

// What happened to a release picked from a source list, as the player saw it: an outcome line in the local pick log
// (picks.ts), tied to its pick. Nothing is logged for a release no list pick names; that is not an error.
api.post('/picks/outcome', (req, res) => {
  const { videoId, chosen, outcome, pos, watchedSec } = req.body || {};
  if (typeof videoId !== 'string' || !videoId || videoId.length > 200 || typeof chosen !== 'string' || !/^[0-9a-f]{40}:-?\d{1,5}$/.test(chosen) || !picks.isOutcome(outcome)) throw httpError(400, 'Not an outcome');
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  picks.recordOutcome({ videoId, chosen, outcome, pos: num(pos), watchedSec: num(watchedSec) });
  res.status(204).end();
});

api.all('/file/:infoHash/:idx', async (req, res) => {
  // Open without the PIN (TVs fetch it), so a hash Kino never chose must not make this Mac join a torrent.
  const h = req.params.infoHash as string;
  const t = torrent.getTorrent(h) || (torrent.isKnown(h) ? await torrent.ensure(h) : undefined);
  if (!t) { res.status(404).json({ error: 'file not found' }); return; }
  serveFile(req, res, t, Number(req.params.idx));
});

const HLS_MIME: Record<string, string> = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4' };
api.get('/hls/:sid/:file', async (req, res) => {
  const s = hls.get(req.params.sid as string);
  if (!s) { res.status(404).json({ error: 'session gone' }); return; }
  const file = req.params.file as string;
  if (!/^\w[\w.-]*$/.test(file)) { res.status(400).end(); return; }   // no "..": that is HLS_DIR itself
  if (file.endsWith('.m3u8')) await hls.waitReady(s, 40_000);
  // A segment asked for before ffmpeg has renamed it into place (temp_file): served the moment it lands, 20 s at most.
  if (!(await hls.waitFile(s, file, 20_000))) { res.status(404).end(); return; }
  const p = path.join(s.dir, file);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', HLS_MIME[file.split('.').pop() || ''] || 'application/octet-stream');
  res.sendFile(p);
});
api.post('/hls/:sid/seek', async (req, res) => {
  const time = hlsSeekTime(req.body?.time);   // a garbled time is a 400 whether or not the session is still there
  const s = hls.get(req.params.sid as string);
  if (!s) throw httpError(404, 'session gone', 'session-gone');
  const ns = hls.seek(s, hlsSeekTime(time, s.probe.duration));
  // Wait for the first segment so timeOffset is the measured one (copy mode
  // starts at the previous keyframe); the playlist fetch would wait anyway.
  try { await hls.waitReady(ns, 40_000); } catch (e) { if ((e as { status?: number }).status !== 503) throw e; }
  await ns.measured?.catch(() => undefined);
  res.json({ url: `/api/hls/${ns.id}/index.m3u8`, sessionId: ns.id, timeOffset: ns.startOffset });
});
api.post('/hls/:sid/ping', (req, res) => { res.json({ ok: hls.touch(req.params.sid as string) }); });
api.delete('/hls/:sid', (req, res) => { hls.stop(req.params.sid as string); res.json({ ok: true }); });

api.post('/torrent/add', async (req, res) => {
  const magnet = String(req.body?.magnet || '').trim();
  const t = await torrent.ensure(magnet);
  res.json({ infoHash: t.infoHash, name: t.name, files: torrent.listFiles(t) });
});
// The magnet screen adds with POST /torrent/add (cross-site writes are refused), so this only lists a known hash.
api.get('/torrent/:infoHash/files', async (req, res) => {
  const t = await torrent.ensure(await knownHash(req.params.infoHash as string));
  res.json({ infoHash: t.infoHash, name: t.name, files: torrent.listFiles(t) });
});
api.get('/torrent/:infoHash/stats', (req, res) => { res.json(torrent.stats(req.params.infoHash as string, req.query.idx != null ? Number(req.query.idx) : undefined)); });

// Downloads: files held for play later.
api.get('/downloads', (_req, res) => res.json(downloads.list()));
api.post('/downloads', async (req, res) => { res.json(await downloads.add(req.body || {})); });
api.delete('/downloads/:key', async (req, res) => { res.json(await downloads.remove(req.params.key as string)); });
