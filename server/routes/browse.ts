import { errMsg } from '../log.js';
import { getState } from '../store.js';
import * as meta from '../meta.js';
import * as addons from '../addons.js';
import { rankLive } from '../rank.js';
import * as picks from '../picks.js';
import { httpError } from '../errors.js';
import * as torrent from '../torrent.js';
import { ratings, imdbIndex } from '../ratings.js';
import { withImdb } from '../taste.js';
import * as tmdb from '../tmdb.js';
import * as rails from '../discover.js';
import { home } from '../home.js';
import { apiRouter, decodeCaps, log, mt, target } from './util.js';
import type { BrowseType, BrowseSort, Progress } from '../types.js';
import { readYears } from '../years.js';

/** Home, search, Browse, title pages, ratings and the sources for a title. */
export const api = apiRouter();

api.get('/home', async (_req, res) => { res.json(await home()); });

api.get('/search', async (req, res) => {
  const [results, scores] = await Promise.all([meta.search(String(req.query.q || '')), imdbIndex().catch(() => new Map())]);
  res.json({ results: withImdb(results, scores) });
});

api.get('/meta/:type/:id/similar', async (req, res) => { res.json(await rails.similar(mt(String(req.params.type)), req.params.id as string)); });

// Browse: a Cinemeta shelf by kind, genre and sort, fifty at a time. Titles in your history are marked, not hidden.
api.get('/browse/genres', async (_req, res) => { res.json(await rails.browseGenres()); });
api.get('/browse', async (req, res) => {
  const t = String(req.query.type || 'all'); const type: BrowseType = t === 'movie' || t === 'series' ? t : 'all';
  const so = String(req.query.sort || 'top'); const sort: BrowseSort = so === 'rated' || so === 'new' ? so : 'top';
  const genre = String(req.query.genre || '').trim() || undefined;
  res.json(await rails.browse(type, { genre, sort, page: Number(req.query.page) || 0, years: readYears(req.query.from, req.query.to) }));
});
api.get('/meta/:type/:id', async (req, res) => {
  const id = req.params.id as string;
  // Magnet playback has no Cinemeta entry: synthesize one from the torrent so
  // Continue Watching cards and the hero's Details button still land somewhere.
  if (id.startsWith('magnet:')) {
    const infoHash = id.split(':')[1] || '';
    const t = torrent.getTorrent(infoHash);
    const p = Object.values(getState().progress).find((x) => x.metaId === id);
    res.json({ meta: { id, type: 'movie', name: t?.name || p?.name || 'Magnet link', poster: p?.poster, background: p?.background, description: infoHash ? `Torrent ${infoHash}` : undefined }, progress: p ? { [p.videoId]: p } : {}, inWatchlist: false, following: false });
    return;
  }
  let m = await meta.meta(mt(req.params.type as string), id);
  const s = getState();
  if (m.videos?.length && s.settings.tmdbApiKey) {
    try { m = { ...m, videos: tmdb.withStills(m.videos, await tmdb.episodeStills(id, [...new Set(m.videos.map((v) => v.season))], s.settings.tmdbApiKey)) }; }
    catch (e) { log.debug('episode stills failed', { id, err: errMsg(e) }); }
  }
  const progress: Record<string, Progress> = {};
  for (const [k, v] of Object.entries(s.progress)) if (v.metaId === m.id) progress[k] = v;
  res.json({ meta: m, progress, inWatchlist: s.watchlist.some((w) => w.id === m.id), following: s.following.some((f) => f.id === m.id) });
});

api.get('/ratings/:type/:id', async (req, res) => { res.json(await ratings(mt(req.params.type as string), req.params.id as string)); });

api.get('/streams/:type/:videoId', async (req, res) => {
  const tg = target(req.query.target); const kind = mt(req.params.type as string); const videoId = req.params.videoId as string;
  // A browser says which codecs it decodes besides H.264: the ranking charges those no transcode. Nothing is cached ranked.
  const caps = tg === 'browser' ? decodeCaps(req.query) : undefined;
  // The running time (from the title's metadata, usually cached by now) tells the pick what bitrate a file needs.
  const [{ sources, queried, failed }, runtimeSec] = await Promise.all([addons.getStreams(kind, videoId), meta.runtimeOf(kind, videoId)]);
  // Live seeders, the running time and the kind asked for (a film titled "Open Season 2" is never a season pack), as a TV's auto-next ranks.
  const { ranked, auto } = await rankLive(sources, tg, kind, { runtimeSec, caps, binge: typeof req.query.binge === 'string' ? req.query.binge : undefined });
  const pickKey = ranked.length ? picks.remember({ videoId, type: kind, target: tg, caps, runtimeSec, auto: auto?.id, sources: ranked }) : undefined;
  res.json({ sources: ranked, auto: auto?.id, addonsQueried: queried, addonsFailed: failed, pickKey });
});

// A release played or cast from a source list: one line in the local pick log (picks.ts), to tune the automatic pick on.
api.post('/picks', (req, res) => {
  const { key, chosen, via } = req.body || {};
  if (typeof key !== 'string' || !/^[0-9a-f]{12}$/.test(key) || typeof chosen !== 'string' || !/^[0-9a-f]{40}:-?\d{1,5}$/.test(chosen)) throw httpError(400, 'Not a pick');
  picks.record(key, chosen, via === 'cast' ? 'cast' : 'play');
  res.status(204).end();
});
