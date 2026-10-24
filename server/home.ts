import { DAY_MS } from './config.js';
import { logger, errMsg } from './log.js';
import { getState, continueWatching, finishedSeriesHeads } from './store.js';
import * as meta from './meta.js';
import * as rails from './discover.js';
import { imdbIndex } from './ratings.js';
import { isFinished, withImdb } from './taste.js';
import { comingUp } from './upcoming.js';
import { episodeName } from './episode-name.js';
import type { DiscoverRow, Episode, HomeResponse, Meta, MetaPreview, Progress } from './types.js';

const log = logger('http');

/** Most items in a Home row: Continue watching, New episodes, Coming up. */
export const ROW_MAX = 20;
/** New episodes: aired in the last two weeks. */
export const NEW_EPISODE_DAYS = 14;
/** Coming up also covers any series watched in the last two months, followed or not. */
export const WATCHING_DAYS = 60;
/** Shows Home reads episode lists for: this many followed ones, then this many watched ones you do not follow. */
export const FOLLOWING_MAX = 30;
export const WATCHING_MAX = 15;

type Show = { show: MetaPreview; videos?: Episode[] };

/**
 * A show does not leave Continue watching because you finished an episode: it rolls on to the next one.
 * The entry carries no source, so Continue lands on the title page with that episode selected.
 */
export function rollOn(head: Progress, m: Meta, progress: Record<string, Progress>, now: number): Progress | undefined {
  const next = meta.nextEpisode(m, head.videoId, now);
  if (!next) return undefined;
  const done = progress[next.id];
  if (done && isFinished(done)) return undefined;   // already watched, or marked watched by hand
  return { videoId: next.id, metaId: head.metaId, type: 'series', pos: 0, dur: 0, updatedAt: head.updatedAt, name: episodeName(m.name, next.season, next.episode, next.title), poster: m.poster || head.poster, background: next.thumbnail || m.background || head.background, season: next.season, episode: next.episode };
}

/** Continue watching with the rolled-on episodes mixed in, most recent first. */
export const withRolled = (cw: Progress[], rolled: (Progress | undefined)[]): Progress[] =>
  [...cw, ...rolled.filter((p): p is Progress => !!p)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, ROW_MAX);

/** Series watched in the last WATCHING_DAYS that you do not follow, most recent first. Magnet plays have no episode list. */
export function watchingIds(progress: Record<string, Progress>, following: { id: string }[], now: number): string[] {
  const followed = new Set(following.map((f) => f.id));
  const recent = Object.values(progress).filter((p) => p.type === 'series' && p.updatedAt > now - WATCHING_DAYS * DAY_MS && !p.metaId.startsWith('magnet:'));
  return [...new Set(recent.sort((a, b) => b.updatedAt - a.updatedAt).map((p) => p.metaId))].filter((id) => !followed.has(id));
}

/** The shows Home reads episode lists for: followed ones first, then ones you have been watching. */
export const showIds = (following: { id: string }[], watching: string[]): string[] =>
  [...following.slice(0, FOLLOWING_MAX).map((f) => f.id), ...watching.slice(0, WATCHING_MAX)];

/** Episodes of these (followed) shows that aired in the last NEW_EPISODE_DAYS and you have not finished, newest first. */
export function newEpisodes(shows: Show[], progress: Record<string, Progress>, now: number): HomeResponse['newEpisodes'] {
  const since = now - NEW_EPISODE_DAYS * DAY_MS;
  const out: HomeResponse['newEpisodes'] = [];
  for (const { show, videos } of shows) {
    for (const e of (videos || []).filter((v) => v.season > 0 && v.released && Date.parse(v.released) >= since && Date.parse(v.released) <= now)) {
      const p = progress[e.id];
      if (p && isFinished(p)) continue;
      out.push({ show, episode: e });
    }
  }
  return out.sort((a, b) => Date.parse(b.episode.released || '') - Date.parse(a.episode.released || '')).slice(0, ROW_MAX);
}

async function continueRow(): Promise<Progress[]> {
  const cw = continueWatching();
  const have = new Set(cw.map((p) => p.metaId));
  const heads = finishedSeriesHeads().filter((p) => !have.has(p.metaId));
  const rolled = await Promise.all(heads.map(async (p) => {
    try { return rollOn(p, await meta.meta('series', p.metaId), getState().progress, Date.now()); } catch { return undefined; }
  }));
  return withRolled(cw, rolled);
}

/** Everything the Home screen shows, in one response. */
export async function home(): Promise<HomeResponse> {
  const s = getState();
  const cw = await continueRow();
  const [pm, ps, discover, scores] = await Promise.all([meta.popular('movie').catch(() => []), meta.popular('series').catch(() => []), rails.homeRows().catch((e): DiscoverRow[] => { log.warn('rails failed', { err: errMsg(e) }); return []; }), imdbIndex().catch(() => new Map())]);
  const now = Date.now();
  const followed = new Set(s.following.map((f) => f.id));
  const shows = (await Promise.all(showIds(s.following, watchingIds(s.progress, s.following, now)).map(async (id) => {
    try {
      const m = await meta.meta('series', id);
      const show: MetaPreview = { id: m.id, type: 'series', name: m.name, poster: m.poster, background: m.background, year: m.year };
      return { id, show, videos: m.videos };
    } catch { return undefined; }
  }))).filter((x): x is NonNullable<typeof x> => !!x);
  return {
    continueWatching: cw,
    discover,
    popularMovies: withImdb(pm, scores), popularSeries: withImdb(ps, scores),
    watchlist: withImdb(s.watchlist.map((w): MetaPreview => ({ id: w.id, type: w.type, name: w.name, poster: w.poster })).reverse(), scores),
    following: withImdb(s.following.map((f): MetaPreview => ({ id: f.id, type: 'series', name: f.name, poster: f.poster })).reverse(), scores),
    newEpisodes: newEpisodes(shows.filter((x) => followed.has(x.id)), s.progress, now),
    upcoming: comingUp(shows, now).slice(0, ROW_MAX),
  };
}
