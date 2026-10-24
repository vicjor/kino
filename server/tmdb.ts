import { DAY_MS } from './config.js';
import { fetchJson, TtlCache } from './http.js';
import { logger, errMsg } from './log.js';
import type { MediaType, MetaPreview, Episode } from './types.js';

const log = logger('tmdb');
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const cache = new TtlCache<MetaPreview[]>(6 * 3600_000);

/** At most eight TMDB calls in flight. A cold build of the rails is a few hundred small calls; TMDB frowns on bursts. */
const MAX_INFLIGHT = 8;
/** At most `max` calls of the returned gate run at once. A finished call hands its slot straight to the next in line, so a newcomer cannot slip in between. */
export function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let inflight = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (inflight >= max) await new Promise<void>((r) => waiting.push(r));
    else inflight++;
    try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else inflight--; }
  };
}
const gated = limiter(MAX_INFLIGHT);
const get = <T>(url: string, timeoutMs = 12_000) => gated(() => fetchJson<T>(url, timeoutMs));

export interface TmdbItem { id: number; title?: string; name?: string; poster_path?: string | null; backdrop_path?: string | null; release_date?: string; first_air_date?: string; overview?: string; genre_ids?: number[]; vote_average?: number; vote_count?: number }
type Kind = 'movie' | 'tv';
const kindOf = (t: MediaType): Kind => (t === 'movie' ? 'movie' : 'tv');

/** TMDB's genre ids, which never change. Lets list items carry genre names without a lookup. */
const GENRE_NAMES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

/** A TMDB list item as Kino's preview: needs the IMDb id, since every title page keys on it. */
export function toPreview(it: TmdbItem, kind: Kind, imdbId: string): MetaPreview {
  const date = it.release_date || it.first_air_date || '';
  // TMDB's score is only worth showing once enough people voted; it is not IMDb's, so it gets its own field.
  const rated = (it.vote_count || 0) >= 50 && it.vote_average ? { tmdbRating: it.vote_average.toFixed(1) } : {};
  const genres = (it.genre_ids || []).map((g) => GENRE_NAMES[g]).filter((g): g is string => !!g);
  return {
    id: imdbId, type: kind === 'movie' ? 'movie' : 'series', name: (it.title || it.name || '').trim(),
    poster: it.poster_path ? `${IMG}/w342${it.poster_path}` : undefined, background: it.backdrop_path ? `${IMG}/w1280${it.backdrop_path}` : undefined,
    year: date ? date.slice(0, 4) : undefined, description: it.overview || undefined, ...rated, ...(genres.length ? { genres } : {}),
  };
}

/**
 * TMDB id -> IMDb id. Ids never change, so this lives for a week; a title TMDB answers for without an
 * IMDb id is remembered as '' so it is not asked again. A failed call (a 429 in a cold build, a timeout)
 * is not remembered: that would hide the title from every shelf for a week.
 */
const imdbIds = new TtlCache<string>(7 * DAY_MS, 5000);
async function imdbIdOf(kind: Kind, id: number, key: string): Promise<string> {
  return imdbIds.wrap(`${kind}:${id}`, async () => (await get<{ imdb_id?: string | null }>(`${API}/${kind}/${id}/external_ids?api_key=${encodeURIComponent(key)}`)).imdb_id || '');
}

/** Items as previews keyed by IMDb id; one small call per unseen item, in parallel. Items without an IMDb id are dropped. */
async function resolve(items: TmdbItem[], kind: Kind, key: string, limit: number): Promise<MetaPreview[]> {
  const idOf = (it: TmdbItem) => imdbIdOf(kind, it.id, key).catch((e) => { log.debug('external id failed', { id: it.id, err: errMsg(e) }); return ''; });
  const out = await Promise.all(items.slice(0, limit).map(async (it) => { const id = await idOf(it); return id ? toPreview(it, kind, id) : undefined; }));
  return out.filter((x): x is MetaPreview => !!x);
}

const q = (key: string, extra: Record<string, string | number | undefined> = {}) =>
  Object.entries({ api_key: key, ...extra }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

/** What the world watched this week, per TMDB. Cached for six hours. */
export async function trending(type: MediaType, key: string, limit = 20): Promise<MetaPreview[]> {
  const kind = kindOf(type);
  return cache.wrap(`trending:${kind}`, async () => {
    const r = await get<{ results: TmdbItem[] }>(`${API}/trending/${kind}/week?${q(key)}`);
    return resolve(r.results || [], kind, key, limit);
  });
}

/** TMDB's own id (and original language) for an IMDb id, via /find. id 0 when TMDB does not know the title. */
export interface Found { id: number; lang?: string }
const found = new TtlCache<Found>(7 * DAY_MS, 5000);
export async function lookup(type: MediaType, imdbId: string, key: string): Promise<Found> {
  const kind = kindOf(type);
  return found.wrap(`${kind}:${imdbId}`, async () => {
    type Hit = { id: number; original_language?: string };
    const f = await get<{ movie_results?: Hit[]; tv_results?: Hit[] }>(`${API}/find/${encodeURIComponent(imdbId)}?${q(key, { external_source: 'imdb_id' })}`);
    const hit = (kind === 'movie' ? f.movie_results : f.tv_results)?.[0];
    return hit ? { id: hit.id, lang: hit.original_language } : { id: 0 };
  });
}

/**
 * What people who watched this also watched, per TMDB. This is the one list that feels like a
 * friend's suggestion rather than a genre shelf: a dystopian drama leads to other dystopian dramas, not to every drama.
 * (TMDB's "similar" endpoint is keyword overlap and lands on nonsense; it is not used.)
 */
export async function recommendations(type: MediaType, imdbId: string, key: string, limit = 24): Promise<MetaPreview[]> {
  const kind = kindOf(type);
  return cache.wrap(`recs:${kind}:${imdbId}`, async () => {
    const { id } = await lookup(type, imdbId, key);
    if (!id) return [];
    const pages = await Promise.all([1, 2].map((page) => get<{ results: TmdbItem[] }>(`${API}/${kind}/${id}/recommendations?${q(key, { page })}`).catch(() => undefined)));
    // Both pages failing is an outage, not "no recommendations": throw, so an empty list is not cached for six hours.
    if (!pages.some(Boolean)) throw new Error(`recommendations failed for ${imdbId}`);
    const items = pages.flatMap((p) => p?.results || []).filter((it) => (it.vote_count || 0) >= 30);
    return resolve(items, kind, key, limit);
  });
}

/** TMDB's genre names and ids for a kind. Names differ from Cinemeta's ("Sci-Fi & Fantasy" vs "Sci-Fi"), so lookups are loose. */
const genreCache = new TtlCache<{ id: number; name: string }[]>(DAY_MS);
export async function genres(type: MediaType, key: string): Promise<{ id: number; name: string }[]> {
  const kind = kindOf(type);
  return genreCache.wrap(kind, async () => (await get<{ genres: { id: number; name: string }[] }>(`${API}/genre/${kind}/list?${q(key)}`)).genres || []);
}
export function genreId(list: { id: number; name: string }[], name: string): number | undefined {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  return list.find((g) => g.name.toLowerCase().replace(/[^a-z]/g, '') === n)?.id
    ?? list.find((g) => g.name.toLowerCase().split(/\s*&\s*/).some((part) => part.replace(/[^a-z]/g, '') === n))?.id;
}

export interface DiscoverFilter {
  sort?: 'popularity.desc' | 'vote_average.desc' | 'vote_count.desc' | 'primary_release_date.desc' | 'first_air_date.desc';
  genre?: number; anyGenre?: number[]; withoutGenres?: number[];   // anyGenre: at least one of these (TMDB ORs with a pipe)
  minVotes?: number; maxVotes?: number; minRating?: number;
  since?: string; until?: string;   // ISO dates on the release date
  language?: string;                // original language, ISO 639-1
  page?: number;
}
/** The query string for /discover, as TMDB spells it. Pure, so the shapes of the rails are testable. */
export function discoverQuery(kind: Kind, f: DiscoverFilter): Record<string, string | number | undefined> {
  const date = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
  return {
    sort_by: f.sort || 'popularity.desc', page: f.page || 1, include_adult: 'false',
    with_genres: f.genre ?? (f.anyGenre?.length ? f.anyGenre.join('|') : undefined), without_genres: f.withoutGenres?.join(','),
    'vote_count.gte': f.minVotes, 'vote_count.lte': f.maxVotes, 'vote_average.gte': f.minRating,
    [`${date}.gte`]: f.since, [`${date}.lte`]: f.until, with_original_language: f.language,
  };
}
export async function discover(type: MediaType, key: string, f: DiscoverFilter, limit = 20): Promise<MetaPreview[]> {
  const kind = kindOf(type);
  const params = discoverQuery(kind, f);
  return cache.wrap(`discover:${kind}:${JSON.stringify(params)}`, async () => {
    const r = await get<{ results: TmdbItem[] }>(`${API}/discover/${kind}?${q(key, params)}`);
    return resolve(r.results || [], kind, key, limit);
  });
}

const stills = new TtlCache<Map<string, string>>(6 * 3600_000);
interface SeasonEpisode { season_number: number; episode_number: number; still_path?: string | null }

/**
 * Episode stills straight from TMDB, keyed "season:episode". Cinemeta's thumbnails redirect to TMDB paths
 * that go stale when TMDB swaps a still, and then 403: new episodes show a broken image. The show's TMDB id
 * (lookup, cached a week) plus one show call with up to twenty seasons appended; cached six hours.
 */
export async function episodeStills(imdbId: string, seasons: number[], key: string): Promise<Map<string, string>> {
  // TMDB appends twenty seasons at most; the newest are the ones whose stills go stale, so a long show keeps its last twenty.
  const wanted = seasons.filter((n) => n > 0).sort((a, b) => a - b).slice(-20);
  if (!wanted.length) return new Map();
  return stills.wrap(`${imdbId}:${wanted.join(',')}`, async () => {
    const { id: tv } = await lookup('series', imdbId, key);
    if (!tv) return new Map();
    const show = await get<Record<string, { episodes?: SeasonEpisode[] } | unknown>>(`${API}/tv/${tv}?${q(key)}&append_to_response=${wanted.map((n) => `season/${n}`).join(',')}`, 15_000);
    const out = new Map<string, string>();
    for (const n of wanted) {
      const season = show[`season/${n}`] as { episodes?: SeasonEpisode[] } | undefined;
      for (const e of season?.episodes || []) if (e.still_path) out.set(`${e.season_number}:${e.episode_number}`, `${IMG}/w780${e.still_path}`);
    }
    return out;
  });
}

/** TMDB's still wins where it has one; Cinemeta's stays for the rest. Pure, so it is testable. */
export function withStills(videos: Episode[], map: Map<string, string>): Episode[] {
  return videos.map((v) => { const t = map.get(`${v.season}:${v.episode}`); return t ? { ...v, thumbnail: t } : v; });
}
