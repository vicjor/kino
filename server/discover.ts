import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CINEMETA, DAY_MS } from './config.js';
import { fetchJson, TtlCache } from './http.js';
import { logger, errMsg } from './log.js';
import { getState } from './store.js';
import * as meta from './meta.js';
import * as tmdb from './tmdb.js';
import { imdbIndex } from './ratings.js';
import { seeds, genreTaste, seriesShare, dominantLanguage, dayIndex, rotate, seedReason, finishRows, interleave, shelfNoise, rankByImdb, withImdb, imdbFloor, hiddenGems, GENERIC, type Seed } from './taste.js';
import type { MediaType, MetaPreview, DiscoverRow, BrowseType, BrowseSort, BrowseResponse, BrowseGenres } from './types.js';
import { inYears, yearDates, type Years } from './years.js';

const log = logger('discover');

/*
 * The rails on Home, and the Browse pages behind them.
 *
 * What makes a rail worth scrolling: it answers a question you might actually have
 * ("what after the show I just finished?", "what is new and good?", "what is everyone watching?"), it
 * never shows what you have already seen, it says why it is there, and it is not the
 * same tomorrow. The personal rows come from TMDB's co-watch recommendations when a key
 * is set, and from Cinemeta's genre shelves otherwise.
 */

const FALLBACK_GENRES = ['Thriller', 'Comedy', 'Sci-Fi', 'Crime', 'Documentary', 'Mystery'];
const plural = (t: MediaType) => (t === 'movie' ? 'movies' : 'series');
const isoDaysAgo = (days: number, now: number) => new Date(now - days * DAY_MS).toISOString().slice(0, 10);
export const browseHref = (type: BrowseType, opts: { genre?: string; sort?: BrowseSort } = {}) => {
  const qs = [opts.genre ? `genre=${encodeURIComponent(opts.genre)}` : '', opts.sort && opts.sort !== 'top' ? `sort=${opts.sort}` : ''].filter(Boolean).join('&');
  return `#/browse/${type}${qs ? `?${qs}` : ''}`;
};

interface Plan { key: string; title: string; reason?: string; href?: string; run: () => Promise<MetaPreview[]> }

/** Seeds that steer the "Because you watched" rails: the two heaviest, plus one that rotates daily among the next three. */
export function pickSeeds(all: Seed[], day: number): Seed[] {
  const top = all.slice(0, 2);
  const rest = rotate(all.slice(2, 5), day);
  return rest.length ? [...top, rest[0]] : top;
}

/** What you watch, as the rails need it: seeds, their genres, your genres and your language. Cached per fingerprint. */
interface Profile { all: Seed[]; genresOf: Map<string, string[]>; taste: string[]; language?: string }
let profileMemo: { fp: string; at: number; p: Promise<Profile> } | undefined;
async function buildProfile(now: number): Promise<Profile> {
  const s = getState();
  const key = s.settings.tmdbApiKey;
  const all = seeds(Object.values(s.progress), now);
  // Genres come from the titles themselves; eight seeds is plenty to know what you like.
  const top8 = all.slice(0, 8);
  const [metas, langs] = await Promise.all([
    Promise.all(top8.map((x) => meta.meta(x.type, x.metaId).then((m) => ({ weight: x.weight, genres: m.genres || [] })).catch(() => ({ weight: 0, genres: [] as string[] })))),
    Promise.all(top8.map((x) => (key ? tmdb.lookup(x.type, x.metaId, key).then((f) => ({ weight: x.weight, lang: f.lang })).catch(() => ({ weight: 0 })) : Promise.resolve({ weight: 0 })))),
  ]);
  return { all, genresOf: new Map(top8.map((x, i) => [x.metaId, metas[i].genres])), taste: genreTaste(metas).filter((g) => !GENERIC.has(g)), language: dominantLanguage(langs) };
}
function profile(now = Date.now()): Promise<Profile> {
  const fp = fingerprint();
  if (!profileMemo || profileMemo.fp !== fp || now - profileMemo.at > FRESH_MS) {
    const p = buildProfile(now);
    profileMemo = { fp, at: now, p };
    p.catch(() => { if (profileMemo?.p === p) profileMemo = undefined; });
  }
  return profileMemo.p;
}

async function buildRows(now = Date.now()): Promise<DiscoverRow[]> {
  const key = getState().settings.tmdbApiKey;
  const { all, genresOf, taste, language } = await profile(now);
  const day = dayIndex(now);
  const share = seriesShare(all);
  const main: MediaType = share >= 0.5 ? 'series' : 'movie';
  const other: MediaType = main === 'series' ? 'movie' : 'series';
  const genreOrder = [...rotate(taste.slice(0, 4), day), ...taste.slice(4), ...FALLBACK_GENRES].filter((g, i, a) => a.indexOf(g) === i);
  const used = new Set<string>();
  const nextGenre = () => { const g = genreOrder.find((x) => !used.has(x)); if (g) used.add(g); return g; };
  const known = (g: string) => taste.includes(g);
  const genreOf = (x: Seed) => { const gs = genresOf.get(x.metaId) || []; return gs.find((g) => !GENERIC.has(g)) || gs[0]; };

  const plan: Plan[] = [];
  if (key) plan.push({ key: 'trending', title: 'Trending this week', reason: 'What the world is watching', href: browseHref('all'), run: async () => interleave(await tmdb.trending('movie', key), await tmdb.trending('series', key)) });
  const picked = pickSeeds(all, day);
  for (const x of picked) {
    plan.push({
      key: `because-${x.metaId}`, title: `Because you watched ${x.name}`, reason: seedReason(x),
      run: async () => {
        if (key) { const r = await tmdb.recommendations(x.type, x.metaId, key).catch(() => [] as MetaPreview[]); if (r.length >= 6) return r; }
        const g = genreOf(x);
        return g ? meta.catalog(x.type, 'top', { genre: g }) : [];
      },
    });
  }
  plan.push({
    key: 'new', title: 'New and worth it', reason: 'Out in the last year, rated well', href: browseHref('all', { sort: 'new' }),
    run: async () => {
      if (key) {
        const since = isoDaysAgo(365, now);
        const [m, t] = await Promise.all([
          tmdb.discover('movie', key, { since, minVotes: 300, minRating: 6.5, language }),
          tmdb.discover('series', key, { since, minVotes: 200, minRating: 7, language }),
        ]);
        const good = imdbFloor(interleave(m, t), await imdbIndex().catch(() => new Map()), 6.8);
        if (good.length >= 6) return good;
      }
      return interleave(await meta.catalog('movie', 'year'), await meta.catalog('series', 'year'));
    },
  });
  const g1 = nextGenre();
  if (g1) plan.push({ key: `genre-${g1}`, title: `${g1} ${plural(main)}`, reason: known(g1) ? 'You watch a lot of this' : undefined, href: browseHref(main, { genre: g1 }), run: () => meta.catalog(main, 'top', { genre: g1 }) });
  if (key) {
    plan.push({
      key: 'gems', title: 'Hidden gems', reason: 'Loved by the few who have seen them',
      run: () => gemsRail(key, all.filter((x) => !picked.includes(x)), taste, language),   // the picked seeds already have a rail of their own
    });
  }
  const g2 = nextGenre();
  if (g2) plan.push({ key: `rated-${g2}`, title: `Top rated ${g2.toLowerCase()} ${plural(main)}`, reason: key ? 'Highest rated, widely seen' : 'Highest on IMDb', href: browseHref(main, { genre: g2, sort: 'rated' }), run: () => ratedShelf(main, g2, 0, key, { language, taste }) });
  const g3 = nextGenre();
  if (g3) plan.push({ key: `genre-${g3}-${other}`, title: `${g3} ${plural(other)}`, reason: known(g3) ? 'You watch a lot of this' : undefined, href: browseHref(other, { genre: g3 }), run: () => meta.catalog(other, 'top', { genre: g3 }) });
  plan.push({ key: 'popular', title: 'Popular now', reason: 'Most watched on Cinemeta', href: browseHref('all'), run: async () => interleave(await meta.catalog('movie', 'top'), await meta.catalog('series', 'top')) });

  const scores = await imdbIndex().catch(() => new Map());
  const rows = await Promise.allSettled(plan.map(async (p) => ({ key: p.key, title: p.title, reason: p.reason, href: p.href, items: withImdb(await p.run(), scores) })));
  return rows.flatMap((r, i) => { if (r.status === 'fulfilled') return [r.value]; log.debug('rail failed', { key: plan[i].key, err: errMsg(r.reason) }); return []; });
}

// ---------------------------------------------------------------- serving --
/**
 * Rails are slow to build cold (a few hundred small calls the first time) and cheap to serve
 * after. The last build is kept on disk, so Home paints at once even right after a restart,
 * and is rebuilt in the background when it is older than half an hour or when what you watch
 * has changed. What you have seen since is filtered out at serve time, never shown stale.
 */
const FILE = path.join(DATA_DIR, 'discover.json');
const FRESH_MS = 30 * 60_000;
/** Bump when the rails are built differently, so a deploy does not serve the old ones from disk. */
const RAILS_VERSION = 3;
interface Built { at: number; fingerprint: string; rows: DiscoverRow[] }
let built: Built | undefined;
let building: Promise<Built> | undefined;

const railsPrefix = (version: number) => `v${version}:`;

/**
 * A build saved on disk, if this version of Kino built it. homeRows() serves whatever it has while it
 * rebuilds, so rails from before a RAILS_VERSION bump must not get that far: they would be the first Home after a deploy.
 */
export function usableBuild(b: unknown, version = RAILS_VERSION): Built | undefined {
  const x = b as Partial<Built> | null;
  return x && Array.isArray(x.rows) && typeof x.fingerprint === 'string' && x.fingerprint.startsWith(railsPrefix(version)) ? (x as Built) : undefined;
}
function load(): Built | undefined {
  try { return usableBuild(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return undefined; }
}
function fingerprint(): string {
  const s = getState();
  return `${railsPrefix(RAILS_VERSION)}${s.settings.tmdbApiKey ? 'k' : ''}:${seeds(Object.values(s.progress)).slice(0, 5).map((x) => x.metaId).join(',')}:${dayIndex()}`;
}
function excludeSet(): Set<string> {
  const s = getState();
  return new Set([...Object.values(s.progress).map((p) => p.metaId), ...s.watchlist.map((w) => w.id), ...s.following.map((f) => f.id)]);
}
function rebuild(fp: string): Promise<Built> {
  if (building) return building;
  building = buildRows().then((rows) => {
    built = { at: Date.now(), fingerprint: fp, rows };
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(built)); } catch (e) { log.debug('could not save rails', { err: errMsg(e) }); }
    log.info('rails built', { rows: rows.length });
    return built;
  }).finally(() => { building = undefined; });
  return building;
}

export async function homeRows(): Promise<DiscoverRow[]> {
  built ??= load();
  const fp = fingerprint();
  const stale = !built || built.fingerprint !== fp || Date.now() - built.at > FRESH_MS;
  if (!built) built = await rebuild(fp);
  else if (stale) rebuild(fp).catch((e) => log.warn('rails rebuild failed', { err: errMsg(e) }));
  return finishRows(built.rows, excludeSet());
}

/** Warm the rails at boot so the first Home after a restart does not wait. */
export function warm(): void { homeRows().catch((e) => log.debug('warm failed', { err: errMsg(e) })); }

// ---------------------------------------------------------------- similar --
/** "More like this" on a title page: co-watch recommendations first, the genre shelf when TMDB has nothing. */
export async function similar(type: MediaType, id: string): Promise<{ title: string; reason?: string; genre?: string; items: MetaPreview[] }> {
  const key = getState().settings.tmdbApiKey;
  const self = (x: MetaPreview) => x.id !== id;
  if (key) {
    const items = await tmdb.recommendations(type, id, key).catch(() => [] as MetaPreview[]);
    if (items.length >= 4) return { title: 'More like this', reason: 'People who watched this also watched', items: withImdb(items.filter(self).slice(0, 20), await imdbIndex().catch(() => new Map())) };
  }
  const m = await meta.meta(type, id);
  const genre = (m.genres || []).find((g) => !GENERIC.has(g)) || m.genres?.[0];
  const items = genre ? await meta.catalog(type, 'top', { genre }).catch(() => [] as MetaPreview[]) : [];
  return { title: genre ? `More ${genre.toLowerCase()}` : 'More like this', genre, items: items.filter(self).slice(0, 20) };
}

// ----------------------------------------------------------------- browse --
const PAGE = 50;
const SORT_ID: Record<BrowseSort, meta.CatalogId> = { top: 'top', rated: 'imdbRating', new: 'year' };
const genreIds = (list: { id: number; name: string }[], names: string[]) => names.map((n) => tmdb.genreId(list, n)).filter((n): n is number => !!n);

/**
 * "Hidden gems": IMDb decides what is hidden (a modest vote count) and what is a gem (a high
 * score), see `hiddenGems()`. TMDB only supplies candidates: what people who watched your other shows
 * also watched (a few per seed, so one show does not take the rail; the heaviest seeds have their
 * own "Because you watched" rails), plus TMDB's best rated in
 * your top genres since 2000, a few pages deep. TMDB's own vote counts say little about IMDb's
 * (The Pitt has under 3000 there and 170k on IMDb), so its band here is only a loose prefilter.
 */
const GEM_SEEDS = 6, GEM_PER_SEED = 4, GEM_PAGES = { series: 5, movie: 3 };
async function gemsRail(key: string, all: Seed[], taste: string[], language: string | undefined): Promise<MetaPreview[]> {
  const scores = await imdbIndex().catch(() => new Map());
  const noise = { movie: shelfNoise('movie', taste), series: shelfNoise('series', taste) };
  const cowatched = (await Promise.all(all.slice(0, GEM_SEEDS).map((x) => tmdb.recommendations(x.type, x.metaId, key).then((r) => hiddenGems(r, scores, { noise }).slice(0, GEM_PER_SEED)).catch(() => [] as MetaPreview[])))).flat();
  const shelf = async (type: MediaType) => {
    const list = await tmdb.genres(type, key).catch(() => []);
    const f: tmdb.DiscoverFilter = {
      sort: 'vote_average.desc', anyGenre: genreIds(list, taste.slice(0, 3)), since: '2000-01-01', language,
      minVotes: type === 'series' ? 100 : 300, maxVotes: type === 'series' ? 3000 : 6000,
      withoutGenres: genreIds(list, [...shelfNoise(type, taste), ...(type === 'movie' ? ['Romance'] : [])]),
    };
    return (await Promise.all(Array.from({ length: GEM_PAGES[type] }, (_, i) => tmdb.discover(type, key, { ...f, page: i + 1 }).catch(() => [] as MetaPreview[])))).flat();
  };
  const [tv, mv] = await Promise.all([shelf('series'), shelf('movie')]);
  return hiddenGems([...cowatched, ...interleave(tv, mv)], scores, { noise, taste, cowatched: new Set(cowatched.map((m) => m.id)) });
}

/**
 * "Top rated": with a TMDB key, the most seen titles in the genre (if TMDB knows it by that name),
 * ordered by IMDb's weighted rating. TMDB's own score is fan-driven on TV (The Originals tops
 * Mystery), IMDb's with enough votes is not. Cinemeta's featured list without a key. The rail on
 * Home and the Browse page share this, so See all continues what the rail started.
 */
const RATED_PAGES = 3;
async function ratedShelf(type: MediaType, genre: string | undefined, page: number, key: string | undefined, you: { language?: string; taste?: string[] } = {}, dates: { since?: string; until?: string } = {}): Promise<MetaPreview[]> {
  if (key) {
    const list = await tmdb.genres(type, key).catch(() => []);
    const gid = genre ? tmdb.genreId(list, genre) : undefined;
    if (!genre || gid) {
      const f: tmdb.DiscoverFilter = { sort: 'vote_count.desc', genre: gid, minRating: type === 'movie' ? 6.5 : 7, language: you.language, withoutGenres: genreIds(list, shelfNoise(type, you.taste, genre)), ...dates };
      const pages = await Promise.all(Array.from({ length: RATED_PAGES }, (_, i) => tmdb.discover(type, key, { ...f, page: page * RATED_PAGES + i + 1 }).catch(() => [] as MetaPreview[])));
      const scores = await imdbIndex().catch(() => new Map());
      return rankByImdb(pages.flat().filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i), scores);
    }
  }
  return meta.catalog(type, 'imdbRating', { genre, skip: page * PAGE });
}

/**
 * Popular or new in a window of release years, straight from TMDB so every page is full: the window is part of the
 * query. Undefined when TMDB does not know the genre by that name (the caller filters Cinemeta's shelf instead).
 */
const YEAR_PAGES = 2;
async function yearShelf(type: MediaType, sort: 'top' | 'new', genre: string | undefined, page: number, key: string, dates: { since?: string; until?: string }): Promise<MetaPreview[] | undefined> {
  const list = await tmdb.genres(type, key).catch(() => []);
  const gid = genre ? tmdb.genreId(list, genre) : undefined;
  if (genre && !gid) return undefined;
  const f: tmdb.DiscoverFilter = sort === 'new'
    ? { sort: type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc', genre: gid, minVotes: 10, ...dates }
    : { sort: 'popularity.desc', genre: gid, minVotes: 20, ...dates };
  const pages = await Promise.all(Array.from({ length: YEAR_PAGES }, (_, i) => tmdb.discover(type, key, { ...f, page: page * YEAR_PAGES + i + 1 }).catch(() => [] as MetaPreview[])));
  return pages.flat().filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
}

/**
 * One page of a shelf. `all` alternates movies and series so both are on the first screen. `years` narrows it to a
 * window of release years: asked of TMDB when there is a key, else Cinemeta's shelf filtered (thinner pages).
 */
export async function browse(type: BrowseType, opts: { genre?: string; sort?: BrowseSort; page?: number; years?: Years }): Promise<BrowseResponse> {
  const s = getState();
  const page = Math.max(0, opts.page || 0);
  const sort = opts.sort || 'top';
  const key = s.settings.tmdbApiKey;
  const years = opts.years;
  const dates = years ? yearDates(years, new Date().toISOString().slice(0, 10)) : {};
  const you = sort === 'rated' && key ? await profile().catch(() => undefined) : undefined;
  const cinemeta = (t: MediaType) => (sort === 'rated' ? ratedShelf(t, opts.genre, page, key, { language: you?.language, taste: you?.taste }, dates) : meta.catalog(t, SORT_ID[sort], { genre: opts.genre, skip: page * PAGE }));
  /** The page as fetched (for "is there more") and as shown (the year window applied where the source could not). */
  const one = async (t: MediaType): Promise<{ raw: number; items: MetaPreview[] }> => {
    try {
      const shelf = years && key && sort !== 'rated' ? await yearShelf(t, sort, opts.genre, page, key, dates) : undefined;
      const got = shelf ?? await cinemeta(t);
      return { raw: got.length, items: years ? got.filter((m) => inYears(m.year, years)) : got };
    } catch { return { raw: 0, items: [] }; }
  };
  const lists = type === 'all' ? await Promise.all([one('movie'), one('series')]) : [await one(type)];
  const items = (type === 'all' ? interleave(lists[0].items, lists[1].items) : lists[0].items).filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
  const seen = new Set(Object.values(s.progress).map((p) => p.metaId));
  const full = key && (sort === 'rated' || years) ? (sort === 'rated' ? RATED_PAGES : YEAR_PAGES) * 20 - 10 : PAGE - 10;
  const scores = await imdbIndex().catch(() => new Map());
  return { items: withImdb(items, scores).map((m) => (seen.has(m.id) ? { ...m, watched: true } : m)), page, more: lists.some((l) => l.raw >= full) };
}

const STATIC_GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];
const genreCache = new TtlCache<BrowseGenres>(DAY_MS);
/** The genres Cinemeta can filter by, straight from its manifest. */
export async function browseGenres(): Promise<BrowseGenres> {
  return genreCache.wrap('genres', async () => {
    try {
      const m = await fetchJson<{ catalogs: { type: string; id: string; extra?: { name: string; options?: string[] }[] }[] }>(`${CINEMETA}/manifest.json`);
      const opts = (t: string) => m.catalogs.find((c) => c.type === t && c.id === 'top')?.extra?.find((e) => e.name === 'genre')?.options;
      return { movie: opts('movie') || STATIC_GENRES, series: opts('series') || STATIC_GENRES };
    } catch { return { movie: STATIC_GENRES, series: STATIC_GENRES }; }
  });
}
