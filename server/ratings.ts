import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { DATA_DIR, DAY_MS } from './config.js';
import { fetchJson, TtlCache } from './http.js';
import { logger, errMsg } from './log.js';
import { getState } from './store.js';
import type { MediaType, Ratings } from './types.js';

const log = logger('ratings');

// Per-episode IMDb ratings come from IMDb's own nightly dataset dumps (no key,
// ~63 MB gzipped, refreshed weekly here). A show's episodes are one grep through
// the gz (~0.3 s), the ratings another. Rotten Tomatoes / Metacritic only exist
// behind OMDb's free key, so those are optional.
const DIR = path.join(DATA_DIR, 'imdb');
const FILES = { episode: 'title.episode.tsv.gz', ratings: 'title.ratings.tsv.gz' } as const;
const BASE = 'https://datasets.imdbws.com/';
const MAX_AGE = 7 * DAY_MS;
const cache = new TtlCache<Ratings>(12 * 3600_000, 2000);
let downloading: Promise<void> | null = null;

function fresh(f: string): boolean {
  try { const st = fs.statSync(path.join(DIR, f)); return st.size > 1_000_000 && Date.now() - st.mtimeMs < MAX_AGE; } catch { return false; }
}

async function download(f: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const res = await fetch(BASE + f, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`${res.status} for ${f}`);
  const tmp = path.join(DIR, f + '.tmp');
  await fs.promises.writeFile(tmp, res.body as unknown as AsyncIterable<Uint8Array>);
  fs.renameSync(tmp, path.join(DIR, f));
  log.info('dataset updated', { f, mb: Math.round(fs.statSync(path.join(DIR, f)).size / 1e6) });
}

/** Age of the IMDb dumps in days, or null when missing (shown in Settings > About). */
export function datasetAge(): number | null {
  try { return Math.round((Date.now() - fs.statSync(path.join(DIR, FILES.ratings)).mtimeMs) / DAY_MS); } catch { return null; }
}

/** Make sure both dumps exist; refresh stale ones in the background (old copy keeps serving). */
export function ensureDatasets(): Promise<void> {
  const missing = Object.values(FILES).filter((f) => !fs.existsSync(path.join(DIR, f)));
  const stale = Object.values(FILES).filter((f) => !fresh(f));
  if (!stale.length) return Promise.resolve();
  if (!downloading) {
    downloading = Promise.all(stale.map((f) => download(f).catch((e) => log.warn('dataset download failed', { f, err: errMsg(e) })))).then(() => { downloading = null; });
  }
  return missing.length ? downloading : Promise.resolve();   // only block when we have nothing at all
}

/** Stream a gz dump line by line. Pure Node: no shell, no BSD grep (which takes
 *  40 s for a 130-pattern -f on macOS), works the same inside Electron and on Linux. */
async function scan(file: string, onLine: (line: string) => void): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

/** tconst -> {rating, votes} for the given ids (~0.6 s over the whole dump). */
async function imdbRatings(ids: string[]): Promise<Map<string, { rating: number; votes: number }>> {
  const out = new Map<string, { rating: number; votes: number }>();
  if (!ids.length) return out;
  const want = new Set(ids);
  await scan(FILES.ratings, (line) => {
    const i = line.indexOf('\t'); if (i < 0) return;
    const t = line.slice(0, i);
    if (!want.has(t)) return;
    const [, r, v] = line.split('\t');
    out.set(t, { rating: Number(r), votes: Number(v) });
  });
  return out;
}

/**
 * Every title with a thousand votes or more, held in memory (~110k entries, a few MB): lets TMDB
 * shelves show IMDb's score and be ranked by it without a scan per call. Loaded once per dump.
 */
const INDEX_MIN_VOTES = 1000;
let index: { mtime: number; p: Promise<Map<string, { rating: number; votes: number }>> } | undefined;
export function imdbIndex(): Promise<Map<string, { rating: number; votes: number }>> {
  let mtime = 0;
  try { mtime = fs.statSync(path.join(DIR, FILES.ratings)).mtimeMs; } catch { return Promise.resolve(new Map()); }
  if (index?.mtime === mtime) return index.p;
  const p = (async () => {
    const out = new Map<string, { rating: number; votes: number }>();
    await scan(FILES.ratings, (line) => {
      const [t, r, v] = line.split('\t');
      const votes = Number(v);
      if (votes >= INDEX_MIN_VOTES) out.set(t, { rating: Number(r), votes });
    });
    log.info('imdb index loaded', { titles: out.size });
    return out;
  })();
  index = { mtime, p };
  p.catch((e) => { log.warn('imdb index failed', { err: errMsg(e) }); if (index?.p === p) index = undefined; });
  return p;
}

/** "tt123:1:5" -> episode tconst, for every episode of a show (~2 s over the whole dump). */
async function episodeMap(parent: string): Promise<Map<string, string>> {
  const key = `\t${parent}\t`;
  const m = new Map<string, string>();
  await scan(FILES.episode, (line) => {
    if (!line.includes(key)) return;
    const [t, p, s, e] = line.split('\t');
    if (p === parent && s && e && s !== '\\N' && e !== '\\N') m.set(`${parent}:${Number(s)}:${Number(e)}`, t);
  });
  return m;
}

interface Omdb { Response: string; imdbRating?: string; imdbVotes?: string; Metascore?: string; Ratings?: { Source: string; Value: string }[]; tomatoURL?: string }

export async function ratings(type: MediaType, id: string): Promise<Ratings> {
  const key = `${type}/${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = await lookup(type, id);
  const complete = !!out.imdb && (type !== 'series' || !!out.episodes);
  if (complete || !fs.existsSync(path.join(DIR, FILES.ratings))) cache.set(key, out);
  return out;
}

async function lookup(type: MediaType, id: string): Promise<Ratings> {
  const out: Ratings = { id, imdbUrl: `https://www.imdb.com/title/${id}/` };
  const omdbKey = getState().settings.omdbApiKey;
  const jobs: Promise<void>[] = [];
  if (omdbKey) {
    jobs.push(fetchJson<Omdb>(`https://www.omdbapi.com/?i=${encodeURIComponent(id)}&apikey=${encodeURIComponent(omdbKey)}`, 8000).then((o) => {
      if (o.Response !== 'True') return;
      const rt = o.Ratings?.find((r) => /rotten/i.test(r.Source))?.Value;
      if (rt) out.rottenTomatoes = rt;
      const mc = o.Ratings?.find((r) => /metacritic/i.test(r.Source))?.Value || (o.Metascore && o.Metascore !== 'N/A' ? `${o.Metascore}/100` : undefined);
      if (mc) out.metacritic = mc.split('/')[0];
      if (o.imdbRating && o.imdbRating !== 'N/A') out.imdb = { rating: Number(o.imdbRating), votes: Number((o.imdbVotes || '0').replace(/,/g, '')) };
    }).catch((e) => log.debug('omdb failed', { err: errMsg(e) })));
  }
  jobs.push((async () => {
    await ensureDatasets();
    if (!fs.existsSync(path.join(DIR, FILES.ratings))) return;
    if (type === 'series') {
      const eps = await episodeMap(id);
      const r = await imdbRatings([id, ...eps.values()]);
      out.episodes = {};
      for (const [vid, t] of eps) { const x = r.get(t); if (x) out.episodes[vid] = x; }
      if (!out.imdb && r.get(id)) out.imdb = r.get(id);
    } else if (!out.imdb) {
      out.imdb = (await imdbRatings([id])).get(id);
    }
  })().catch((e) => log.warn('imdb dataset lookup failed', { id, err: errMsg(e) })));
  await Promise.all(jobs);
  return out;
}
