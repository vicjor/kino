import { DAY_MS } from './config.js';
import type { MediaType, MetaPreview, Progress, DiscoverRow } from './types.js';

/*
 * What you actually watch, as numbers. Pure functions over the progress table, so the
 * rails on Home can be reasoned about and tested without a network.
 *
 * A seed is one title you spent time on. Its weight says how much it should steer the
 * recommendations: finished beats abandoned, eight episodes beat one, last week beats
 * last spring. A show opened and closed after a minute barely counts.
 */

export interface Seed { type: MediaType; metaId: string; name: string; weight: number; episodes: number; finished: boolean; lastAt: number }

/** Half the pull is gone after about six weeks. Taste drifts; the rails should too. */
const RECENCY_DAYS = 45;
/** Genres too broad to say anything about taste or to name a shelf after. */
export const GENERIC = new Set(['Drama', 'Action', 'Adventure']);

/** Past this share of the runtime a title counts as watched: the last 5% is credits. */
export const FINISHED_SHARE = 0.95;
/**
 * Played to the end, as far as Kino is concerned. The one server rule (store re-exports it): Continue watching,
 * New episodes, up next and taste all ask this. A title marked watched by hand (see isMarkedWatched) counts.
 */
export function isFinished(p: Pick<Progress, 'pos' | 'dur'>): boolean { return p.dur > 0 && p.pos / p.dur > FINISHED_SHARE; }
/** "Mark as watched" is saved as pos 1 of dur 1: finished, but nothing was played. */
export function isMarkedWatched(p: { pos?: unknown; dur?: unknown } | null | undefined): boolean { return !!p && p.pos === 1 && p.dur === 1; }

export function showName(name: string): string { return name.split(/ S\d+ ?E\d+/i)[0].replace(/\s+·.*$/, '').trim(); }

function completion(p: Progress): number {
  if (p.dur <= 0) return p.pos > 0 ? 0.2 : 0;
  return Math.min(1, p.pos / p.dur);
}

/** One seed per title, heaviest first. Magnet playback has no metadata to recommend from and is skipped. */
export function seeds(progress: Progress[], now = Date.now()): Seed[] {
  const by = new Map<string, Seed>();
  for (const p of progress) {
    if (!p.metaId || p.metaId.startsWith('magnet:')) continue;
    const done = completion(p);
    if (done < 0.05) continue;
    const age = Math.max(0, now - p.updatedAt) / DAY_MS;
    const recency = Math.exp(-age / RECENCY_DAYS);
    const w = recency * (0.3 + 0.7 * done);
    const s = by.get(p.metaId) || { type: p.type, metaId: p.metaId, name: showName(p.name), weight: 0, episodes: 0, finished: false, lastAt: 0 };
    s.weight += w;
    s.episodes += 1;
    s.finished = s.finished || isFinished(p);
    if (p.updatedAt > s.lastAt) { s.lastAt = p.updatedAt; s.name = showName(p.name); }
    by.set(p.metaId, s);
  }
  return [...by.values()].sort((a, b) => b.weight - a.weight || b.lastAt - a.lastAt);
}

/** Genres ranked by how much of your watching they explain. Drama and Action tag almost everything, so they count less. */
export function genreTaste(items: { weight: number; genres?: string[] }[]): string[] {
  const freq = new Map<string, number>();
  for (const it of items) for (const g of (it.genres || []).slice(0, 4)) freq.set(g, (freq.get(g) || 0) + it.weight * (GENERIC.has(g) ? 0.35 : 1));
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

/** Share of your watching that is series, 0..1. Decides whether a genre row shows series or movies first. */
export function seriesShare(s: Seed[]): number {
  const total = s.reduce((n, x) => n + x.weight, 0);
  if (!total) return 0.5;
  return s.filter((x) => x.type === 'series').reduce((n, x) => n + x.weight, 0) / total;
}

/**
 * The language most of your watching is in, when it clearly is one: the shelves that are not
 * seeded by a title (new, gems, top rated) stay in it. Under seventy percent, no filter at all.
 */
export function dominantLanguage(items: { weight: number; lang?: string }[]): string | undefined {
  const by = new Map<string, number>(); let total = 0;
  for (const it of items) { if (!it.lang) continue; total += it.weight; by.set(it.lang, (by.get(it.lang) || 0) + it.weight); }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && total > 0 && top[1] / total >= 0.7 ? top[0] : undefined;
}

/** A number that changes once a day, so rails rotate without being random on every reload. */
export function dayIndex(now = Date.now()): number { return Math.floor(now / DAY_MS); }

/** Start `list` at a position that moves one step per day: the same genres, not always the same one first. */
export function rotate<T>(list: T[], day: number): T[] {
  if (list.length < 2) return list;
  const k = ((day % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

/** How to say why a seed steers a row, in words a person would use. */
export function seedReason(s: Seed): string {
  if (s.type === 'series') return s.episodes > 1 ? `You watched ${s.episodes} episodes` : s.finished ? 'You watched an episode' : 'You started this';
  return s.finished ? 'You watched it' : 'You started it';
}

/**
 * The rails that make the cut: titles you have seen are gone, a title lives in one rail only
 * (the first that had it), and a rail with fewer than `min` left is not worth the scroll.
 */
export function finishRows(rows: DiscoverRow[], exclude: Set<string>, min = 6, max = 24): DiscoverRow[] {
  const seen = new Set<string>();
  const out: DiscoverRow[] = [];
  for (const r of rows) {
    const items: MetaPreview[] = [];
    for (const m of r.items) {
      if (exclude.has(m.id) || seen.has(m.id) || items.some((x) => x.id === m.id)) continue;
      items.push(m);
      if (items.length >= max) break;
    }
    if (items.length < min) continue;
    for (const m of items) seen.add(m.id);
    out.push({ ...r, items });
  }
  return out;
}

/** Alternate two lists so both kinds show up at the top of one rail. */
export function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = []; const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
  return out;
}

/**
 * Genres a "best rated" shelf leaves out. Without this, top rated comedy series is Rick and Morty,
 * Gravity Falls and Adventure Time, and hidden gems are nature documentaries. Animation and family
 * stay in when they are part of what you watch, and a genre you asked for is never left out.
 */
export function shelfNoise(type: MediaType, taste: string[] = [], genre?: string): string[] {
  const base = type === 'series' ? ['Kids', 'Reality', 'Talk', 'News', 'Soap', 'Documentary'] : ['Documentary', 'Music', 'TV Movie'];
  const liked = new Set(taste.slice(0, 6));
  const soft = ['Animation', 'Family'].filter((g) => !liked.has(g));
  const asked = genre?.toLowerCase();
  return [...base, ...soft].filter((g) => g.toLowerCase() !== asked);
}

export type Scores = Map<string, { rating: number; votes: number }>;
/**
 * IMDb's rating pulled toward a middling prior until enough people voted: an 8.9 from 3k fans
 * ranks under an 8.6 from 400k. Same idea as IMDb's own Top 250.
 */
export function weightedRating(rating: number, votes: number, m = 15000, prior = 6.8): number {
  return (votes / (votes + m)) * rating + (m / (votes + m)) * prior;
}
/** Best first by weighted IMDb rating; titles IMDb has no score for keep their order at the end. */
export function rankByImdb(items: MetaPreview[], scores: Scores): MetaPreview[] {
  const w = (m: MetaPreview) => { const s = scores.get(m.id); return s ? weightedRating(s.rating, s.votes) : -1; };
  return items.map((m, i) => ({ m, i, w: w(m) })).sort((a, b) => b.w - a.w || a.i - b.i).map((x) => x.m);
}
/** Fill in IMDb's score where a card only has TMDB's, so every card speaks the same scale. */
export function withImdb(items: MetaPreview[], scores: Scores): MetaPreview[] {
  return items.map((m) => {
    if (cleanRating(m.imdbRating)) return m;
    const s = scores.get(m.id);
    if (s) return { ...m, imdbRating: s.rating.toFixed(1) };
    if (m.imdbRating === undefined) return m;
    const { imdbRating: _, ...rest } = m; return rest;
  });
}
/** A rating as a card can show it, or undefined: Cinemeta sometimes sends "", "N/A" or "0" for "no score yet". */
export function cleanRating(r: string | number | undefined | null): string | undefined {
  const s = r == null ? '' : String(r).trim();
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? s : undefined;
}
/** Drop what IMDb, with a thousand votes or more, rates under `min`. New releases IMDb has no verdict on yet stay. */
export function imdbFloor(items: MetaPreview[], scores: Scores, min: number): MetaPreview[] {
  return items.filter((m) => { const s = scores.get(m.id); return !s || s.rating >= min; });
}

/** Genre names from TMDB and Cinemeta, loosely equal: "Sci-Fi" is in "Sci-Fi & Fantasy", "Science Fiction" is "Sci-Fi". */
const normGenre = (g: string) => g.toLowerCase().replace('science fiction', 'sci-fi').replace(/[^a-z&]/g, '');
export function sameGenre(a: string, b: string): boolean {
  const x = normGenre(a), y = normGenre(b);
  return x === y || x.split('&').includes(y) || y.split('&').includes(x);
}

/**
 * What reads as a hidden gem on IMDb: enough votes to trust the score, few enough that you
 * probably missed it. Series vote less than films and rate higher, so each kind has its own band.
 */
const GEM_BAND: Record<MediaType, { minVotes: number; maxVotes: number; minRating: number }> = {
  series: { minVotes: 5000, maxVotes: 60000, minRating: 8 },
  movie: { minVotes: 10000, maxVotes: 120000, minRating: 7.5 },
};
export interface GemOpts { cowatched?: Set<string>; noise?: Partial<Record<MediaType, string[]>>; taste?: string[] }
/**
 * Hidden gems, best first: only titles inside their kind's IMDb band, scored by how far above the
 * band's floor they sit (a small vote count is pulled toward the floor), so films and series share
 * one list. A nudge up for what people who watched your shows also watched (`cowatched`) and for
 * your top three genres (`taste`). Titles in a `noise` genre for their kind are out, and so is a
 * film that is only Comedy: that is a stand-up special, not what a friend means by a gem.
 */
export function hiddenGems(items: MetaPreview[], scores: Scores, opts: GemOpts = {}): MetaPreview[] {
  const seen = new Set<string>();
  const top = (opts.taste || []).slice(0, 3);
  const ranked: { m: MetaPreview; w: number }[] = [];
  for (const m of items) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const gs = m.genres || [];
    if (gs.some((g) => (opts.noise?.[m.type] || []).some((n) => sameGenre(g, n))) || (m.type === 'movie' && gs.length === 1 && gs[0] === 'Comedy')) continue;
    const s = scores.get(m.id); const b = GEM_BAND[m.type];
    if (!s || !b || s.votes < b.minVotes || s.votes > b.maxVotes || s.rating < b.minRating) continue;
    const nudge = (opts.cowatched?.has(m.id) ? 0.15 : 0) + (gs.some((g) => top.some((t) => sameGenre(g, t))) ? 0.1 : 0);
    ranked.push({ m, w: weightedRating(s.rating, s.votes, 5000, b.minRating) - b.minRating + nudge });
  }
  return ranked.sort((a, b) => b.w - a.w).map((x) => x.m);
}
