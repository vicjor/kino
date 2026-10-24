import { CINEMETA } from './config.js';
import { httpError } from './errors.js';
import { fetchJson, TtlCache, upstreamStatusOf } from './http.js';
import { cleanRating, interleave } from './taste.js';
import type { MediaType, MetaPreview, Meta, Episode } from './types.js';

interface CmMeta {
  id: string; type: string; name: string; poster?: string; background?: string; logo?: string;
  releaseInfo?: string; year?: string | number; imdbRating?: string; genres?: string[]; genre?: string[];
  description?: string; runtime?: string; cast?: string[]; director?: string[];
  trailerStreams?: { title?: string; ytId?: string }[]; trailers?: { source?: string; type?: string }[];
  videos?: { id: string; season: number; episode: number; number?: number; title?: string; name?: string; released?: string; thumbnail?: string; overview?: string; description?: string }[];
}

const TTL = 10 * 60_000;
const STALE = 24 * 3600_000;
/**
 * Metas and catalogs are served up to a day past their ttl while one background call refreshes them, so a slow or failed Cinemeta answer never stalls or empties Home.
 * An answer without a named meta or with no catalog rows is never cached, so it never replaces a good one. Search stays strict.
 */
export const hasMeta = (v: { meta?: CmMeta | null } | null | undefined): boolean => !!v?.meta?.name;
export const hasMetas = (v: { metas?: CmMeta[] | null } | null | undefined): boolean => Array.isArray(v?.metas) && v.metas.length > 0;
const metas = new TtlCache<{ meta: CmMeta }>(TTL, 500, { stale: STALE, valid: hasMeta });
const catalogs = new TtlCache<{ metas: CmMeta[] }>(TTL, 300, { stale: STALE, valid: hasMetas });
const searches = new TtlCache<{ metas: CmMeta[] }>(TTL, 200);

function toPreview(m: CmMeta, type: MediaType): MetaPreview {
  return {
    id: m.id, type: (m.type as MediaType) || type, name: m.name, poster: m.poster, background: m.background,
    year: m.releaseInfo || (m.year != null ? String(m.year) : undefined), imdbRating: cleanRating(m.imdbRating),
    genres: m.genres || m.genre, description: m.description,
  };
}

export type CatalogId = 'top' | 'year' | 'imdbRating';

/** Any Cinemeta catalog: `top` (popular), `year` (this year's releases), `imdbRating` (best rated), optionally narrowed to a genre. */
export async function catalog(type: MediaType, id: CatalogId = 'top', opts: { genre?: string; skip?: number } = {}): Promise<MetaPreview[]> {
  const extra = [opts.genre ? `genre=${encodeURIComponent(opts.genre)}` : '', opts.skip ? `skip=${opts.skip}` : ''].filter(Boolean).join('&');
  const url = `${CINEMETA}/catalog/${type}/${id}${extra ? `/${extra}` : ''}.json`;
  const data = await catalogs.wrap(url, () => fetchJson<{ metas: CmMeta[] }>(url));
  return (data.metas || []).map((m) => toPreview(m, type));
}
export const popular = (type: MediaType, skip = 0) => catalog(type, 'top', { skip });

export async function search(q: string): Promise<MetaPreview[]> {
  const enc = encodeURIComponent(q.trim());
  if (!enc) return [];
  const urls: [MediaType, string][] = [
    ['movie', `${CINEMETA}/catalog/movie/top/search=${enc}.json`],
    ['series', `${CINEMETA}/catalog/series/top/search=${enc}.json`],
  ];
  const res = await Promise.allSettled(urls.map(([t, u]) => searches.wrap(u, () => fetchJson<{ metas: CmMeta[] }>(u)).then((d) => (d.metas || []).map((m) => toPreview(m, t)))));
  const [mv, sr] = res.map((r) => (r.status === 'fulfilled' ? r.value : []));
  return interleave(mv, sr);   // both types show up top
}

/** Cinemeta's 404 page for an id it does not know (the status fetchJson's error carries). It answers `{}` for others. */
export const upstreamNotFound = (e: unknown): boolean => upstreamStatusOf(e) === 404;
const noSuchTitle = () => httpError(404, 'Kino could not find this title');

export async function meta(type: MediaType, id: string): Promise<Meta> {
  const url = `${CINEMETA}/meta/${type}/${id}.json`;
  let data: { meta: CmMeta };
  try { data = await metas.wrap(url, () => fetchJson<{ meta: CmMeta }>(url)); }
  catch (e) { throw upstreamNotFound(e) ? noSuchTitle() : e; }
  if (!hasMeta(data)) throw noSuchTitle();
  const m = data.meta;
  const yt = [...(m.trailerStreams || []).map((t) => t.ytId), ...(m.trailers || []).filter((t) => t.type === 'Trailer').map((t) => t.source)].filter((x): x is string => !!x && /^[\w-]{6,}$/.test(x));
  const out: Meta = { ...toPreview(m, type), logo: m.logo, runtime: m.runtime, cast: m.cast, director: m.director, trailer: yt[0] };
  if (m.videos?.length) {
    out.videos = m.videos
      .filter((v) => v.season != null && v.episode != null)
      .map((v): Episode => ({ id: v.id, season: v.season, episode: v.episode, title: v.title || v.name || `Episode ${v.episode}`, released: v.released, thumbnail: v.thumbnail, overview: v.overview || v.description }))
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
  }
  return out;
}

/** A Cinemeta runtime ("51 min", "1h 52min", "2 h", "95") in seconds, when it is a believable length for one film or episode. */
export function runtimeSeconds(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const h = /(\d+)\s*h/i.exec(s)?.[1], m = /(\d+)\s*m/i.exec(s)?.[1] ?? (h ? undefined : /^\s*(\d+)\s*$/.exec(s)?.[1]);
  const sec = (Number(h ?? 0) * 60 + Number(m ?? 0)) * 60;
  return sec >= 5 * 60 && sec <= 6 * 3600 ? sec : undefined;
}

/**
 * How long a title runs, from its metadata (a series gives a typical episode), for the source pick. Undefined when
 * Cinemeta does not say, fails, or takes longer than waitMs: the pick then assumes a typical length.
 */
export async function runtimeOf(type: MediaType, videoId: string, waitMs = 2000): Promise<number | undefined> {
  const { metaId } = parseVideoId(videoId);
  if (!/^tt\d+$/.test(metaId)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), waitMs); });
  try { return await Promise.race([meta(type, metaId).then((m) => runtimeSeconds(m.runtime), () => undefined), late]); }
  finally { clearTimeout(timer); }
}

/** Next regular episode after videoId within meta.videos (skips season 0 specials), if it is out by `now`. */
export function nextEpisode(m: Meta, videoId: string, now = Date.now()): Episode | undefined {
  const eps = (m.videos || []).filter((e) => e.season > 0);
  const i = eps.findIndex((e) => e.id === videoId);
  if (i < 0) return undefined;
  const next = eps[i + 1];
  if (!next) return undefined;
  if (next.released && Date.parse(next.released) > now) return undefined;
  return next;
}

export function parseVideoId(videoId: string): { metaId: string; season?: number; episode?: number } {
  if (videoId.startsWith('magnet:')) { const parts = videoId.split(':'); return { metaId: parts.slice(0, 2).join(':') }; }
  const [metaId, s, e] = videoId.split(':');
  return s != null && e != null ? { metaId, season: Number(s), episode: Number(e) } : { metaId };
}
