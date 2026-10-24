import { errMsg } from '../log.js';
import { httpError } from '../errors.js';
import { getState, update } from '../store.js';
import * as torrent from '../torrent.js';
import { localFileUrl } from '../media/range.js';
import { probe, probeCached } from '../media/probe.js';
import { listSubtitles, getVtt } from '../subs/index.js';
import { syncSubtitle } from '../subs/sync.js';
import { pushLearned } from '../media/credits.js';
import { creditsFor, introFor, learnIntro } from '../media/credits-lookup.js';
import { isIntroJump } from '../media/intro.js';
import { vttToSrt } from '../subs/srt2vtt.js';
import { apiRouter, log, mt, optKey, knownHash, playRaceMs, wholeIndex } from './util.js';

/** Subtitles, their timing sync, and where the intro and the credits sit. */
export const api = apiRouter();

api.get('/subs', async (req, res) => {
  const infoHash = typeof req.query.infoHash === 'string' ? req.query.infoHash : undefined;
  const fileIdx = req.query.fileIdx != null && req.query.fileIdx !== '' ? Number(req.query.fileIdx) : undefined;
  const t = infoHash ? await torrent.ensure(await knownHash(infoHash, playRaceMs)) : undefined;
  if (t && fileIdx != null && t.files[fileIdx] && !probeCached(`${t.infoHash}:${fileIdx}`)) {
    try { await probe(`${t.infoHash}:${fileIdx}`, localFileUrl(t.infoHash, fileIdx)); } catch (e) { log.debug('probe for subs failed', { err: errMsg(e) }); }
  }
  const videoId = typeof req.query.videoId === 'string' && !req.query.videoId.startsWith('magnet:') ? req.query.videoId : undefined;
  const tracks = await listSubtitles(mt(String(req.query.type)), videoId, t, fileIdx, { acceptLanguage: req.headers['accept-language'] });
  res.json({ tracks });
});
/**
 * Where the credits start for this file: learned presses for the show, chapters, or the last subtitle line.
 * The subtitle read is the slow part (an OpenSubtitles fetch), so the player asks once playback is running.
 */
api.get('/credits', async (req, res) => {
  const infoHash = String(req.query.infoHash || ''); const fileIdx = Number(req.query.fileIdx);
  const videoId = optKey(req.query.videoId, 'video id');
  const metaId = optKey(req.query.metaId, 'meta id');
  if (!infoHash || !isFinite(fileIdx)) throw httpError(400, 'infoHash and fileIdx required');
  res.json(await creditsFor({ infoHash: await knownHash(infoHash), fileIdx, videoId, metaId }));
});
api.post('/credits/learn', (req, res) => {
  const { metaId, offset } = (req.body || {}) as { metaId?: string; offset?: number };
  optKey(metaId, 'meta id');
  if (!metaId || typeof offset !== 'number' || offset < 10 || offset > 3600) { res.status(400).json({ error: 'metaId and a sane offset required' }); return; }
  update((s) => { s.credits[metaId] = pushLearned(s.credits[metaId], offset); });
  res.json({ ok: true, offsets: getState().credits[metaId] });
});

// Skip intro: where the opening titles sit in this file, and learning from a skip you made by hand.
api.get('/intro', async (req, res) => {
  const infoHash = String(req.query.infoHash || ''); const fileIdx = Number(req.query.fileIdx);
  if (!infoHash || !isFinite(fileIdx)) throw httpError(400, 'infoHash and fileIdx required');
  const q = (k: string) => (typeof req.query[k] === 'string' ? req.query[k] as string : undefined);
  const videoId = optKey(q('videoId'), 'video id'); const metaId = optKey(q('metaId'), 'meta id');
  res.json(await introFor({ infoHash: await knownHash(infoHash), fileIdx, videoId, metaId }));
});
api.post('/intro/learn', async (req, res) => {
  const { metaId, start, end, infoHash, fileIdx, videoId } = (req.body || {}) as { metaId?: string; start?: number; end?: number; infoHash?: string; fileIdx?: number; videoId?: string };
  optKey(metaId, 'meta id'); optKey(videoId, 'video id');
  if (!metaId || typeof start !== 'number' || typeof end !== 'number' || !isIntroJump(start, end)) { res.status(400).json({ error: 'metaId and a skip over the opening titles required' }); return; }
  res.json({ ok: true, samples: await learnIntro({ metaId, start, end, infoHash, fileIdx: fileIdx != null ? Number(fileIdx) : undefined, videoId }) });
});

// Align a subtitle to the audio around the current position: three minutes of audio, up to a minute of shift.
api.post('/subs/sync', async (req, res) => {
  const { id, infoHash, fileIdx, from } = (req.body || {}) as { id?: unknown; infoHash?: unknown; fileIdx?: unknown; from?: unknown };
  if (typeof id !== 'string' || !id || typeof infoHash !== 'string' || !infoHash || fileIdx == null) throw httpError(400, 'id, infoHash and fileIdx required');
  if (!wholeIndex(fileIdx)) throw httpError(400, 'fileIdx must be a whole number');
  // Only a torrent Kino loaded: ensure() on any other hash would join its swarm.
  const h = await knownHash(infoHash);
  const t = torrent.getTorrent(h) || (await torrent.ensure(h));
  if (!t.files[fileIdx]) throw httpError(400, 'That torrent has no such file');
  const vtt = await getVtt(id, 0, torrent.getTorrent);
  const r = await syncSubtitle(vtt, localFileUrl(t.infoHash, fileIdx), Math.max(0, Number(from) || 0));
  res.json(r);
});
api.get('/subs/file/:id.srt', async (req, res) => {
  const vtt = await getVtt(req.params.id as string, 0, torrent.getTorrent);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/srt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(vttToSrt(vtt, Number(req.query.offset || 0) || 0));
});
api.get('/subs/file/:id.vtt', async (req, res) => {
  const vtt = await getVtt(req.params.id as string, Number(req.query.offset || 0) || 0, torrent.getTorrent);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(vtt);
});
