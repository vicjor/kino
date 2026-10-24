import { createHash } from 'node:crypto';
import { fetchJson, redact, TtlCache } from './http.js';
import { NO_ANSWER, onLan } from './net-guard.js';
import { logger, errMsg } from './log.js';
import { httpError } from './errors.js';
import { getState, update } from './store.js';
import { parseStream, flagPlaceholderSeeds, type AddonStream } from './parse.js';
import type { AddonInfo, MediaType, Source, CatalogEntry } from './types.js';

const log = logger('addons');

interface Manifest { id: string; name: string; version?: string; resources: (string | { name: string; types?: string[] })[]; types: string[]; idPrefixes?: string[]; catalogs?: { type: string; id: string; name?: string }[] }
export type { Manifest };

const manifests = new TtlCache<Manifest>(60 * 60_000);
const streamCache = new TtlCache<Source[]>(5 * 60_000);

function baseUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/, '');
}

/** Scheme and host of an addon URL. Addons often keep a config token in the path, so logs and error text name no more than this. */
export function addonOrigin(url: string): string {
  try { const o = new URL(url).origin; return o === 'null' ? 'addon' : o; } catch { return 'addon'; }
}

/** A cache key for an addon URL: two installs of one addon with different settings stay apart, and no token lands in a key (keys show up in debug logs). */
export const addonKey = (url: string) => createHash('sha1').update(url).digest('hex').slice(0, 16);

/**
 * fetchJson for an addon, its error text naming the origin instead of the whole URL. Every addon URL shares its origin
 * with the manifest URL the owner configured, so 'own-lan': an addon on the LAN may reach the LAN (a self-hosted addon
 * redirecting to its own box), one on the internet may not, on any hop.
 */
async function fetchAddon<T>(url: string, timeoutMs: number): Promise<T> {
  try { return await fetchJson<T>(url, timeoutMs, { guard: { allowPrivate: 'own-lan', what: 'addon' } }); } catch (e) {
    const full = redact(url);
    if (!(e instanceof Error) || !e.message.includes(full)) throw e;
    throw Object.assign(new Error(e.message.split(full).join(addonOrigin(url))), { status: (e as { status?: number }).status });
  }
}

/** How long a manifest fetch may take. An object so a test can shorten it. */
export const manifestTimeout = { ms: 8000 };
/** A failure an addon is remembered by for a minute: when, and the error (naming the origin, never the whole URL). */
export interface AddonFailure { failedAt: number; reason: string }
const failure = (e: unknown): AddonFailure => ({ failedAt: Date.now(), reason: errMsg(e) });
/**
 * A manifest that just failed is not asked for again for a minute: every streams, subtitles and
 * live request goes through here, and an unreachable addon would otherwise cost each one the full timeout.
 */
const manifestFailed = new TtlCache<AddonFailure>(60_000);
const manifestInflight = new Map<string, Promise<Manifest>>();

/** `retry` skips the minute of failure memory, for when someone asks for this addon on purpose. */
export async function manifest(url: string, opts: { retry?: boolean } = {}): Promise<Manifest> {
  const hit = manifests.get(url);
  if (hit) return hit;
  const failed = opts.retry ? undefined : manifestFailed.get(url);
  if (failed !== undefined) throw new Error(failed.reason);
  let p = manifestInflight.get(url);
  if (!p) {
    p = fetchAddon<Manifest>(url, manifestTimeout.ms).then(
      (m) => manifests.set(url, m),
      (e) => { const f = manifestFailed.set(url, failure(e)); log.warn('manifest failed', { origin: addonOrigin(url), err: f.reason }); throw e; },
    ).finally(() => manifestInflight.delete(url));
    manifestInflight.set(url, p);
  }
  return p;
}

function resources(m: Manifest): string[] {
  return (m.resources || []).map((r) => (typeof r === 'string' ? r : r.name));
}

/** An installed addon as Settings lists it. `skipped`: streams or subtitles are not asked of it for now, it did not answer lately. */
export type AddonRow = AddonInfo & { skipped?: AddonFailure };

export async function listAddons(): Promise<AddonRow[]> {
  const urls = getState().settings.addons;
  const skipped = skippedAddons(urls);
  return Promise.all(urls.map(async (url): Promise<AddonRow> => {
    try {
      const m = await manifest(url, { retry: true });   // Settings shows live status, not a remembered failure
      const skip = skipped[addonKey(url)];
      return { url, name: m.name || addonOrigin(url), version: m.version, resources: resources(m), types: m.types || [], ok: true, ...(skip ? { skipped: skip } : {}) };
    } catch (e) {
      return { url, name: addonOrigin(url), resources: [], types: [], ok: false, error: errMsg(e) };   // the name is shown: never the URL, tokens live in it
    }
  }));
}

export async function addAddon(url: string): Promise<AddonInfo> {
  const u = url.trim().replace(/^stremio:\/\//, 'https://');
  if (!/^https?:\/\/.+manifest\.json/.test(u)) throw httpError(400, 'An addon address starts with http or https and points to its manifest.json');
  let m: Manifest;
  // An addon that does not answer is its problem, not this Mac's: the reason names its origin, never the whole URL.
  try { m = await manifest(u, { retry: true }); } catch (e) { throw httpError(502, `Kino could not load that addon (${errMsg(e)})`); }
  const res = resources(m);
  const types = m.types || [];
  const vod = (res.includes('stream') || res.includes('subtitles')) && types.some((t) => t === 'movie' || t === 'series');
  if (!vod) throw httpError(422, `Addon "${m.name}" serves ${types.length ? types.join(', ') : 'nothing'} Kino can play. It needs streams or subtitles for movies and series.`);
  update((s) => { if (!s.settings.addons.includes(u)) s.settings.addons.push(u); });
  return { url: u, name: m.name || addonOrigin(u), version: m.version, resources: res, types: m.types || [], ok: true };
}

export function removeAddon(url: string): void {
  update((s) => { s.settings.addons = s.settings.addons.filter((a) => a !== url); });
}

function serves(m: Manifest, resource: string, type: string): boolean {
  return (m.resources || []).some((r) => (typeof r === 'string' ? r === resource && (m.types || []).includes(type) : r.name === resource && (r.types || m.types || []).includes(type)));
}

/** Installed addons that serve `resource` for `type`, in settings order. Manifests load in parallel; one that fails is left out (and logged once by manifest()). */
export async function addonsFor(resource: string, type: string): Promise<{ url: string; m: Manifest }[]> {
  const all = await Promise.all(getState().settings.addons.map((url) => manifest(url).then((m) => ({ url, m }), () => undefined)));
  return all.filter((a): a is { url: string; m: Manifest } => !!a && serves(a.m, resource, type));
}

/** No answer at all (timed out, refused, unreachable). An HTTP error or an odd body is an answer: it came fast, and is often about one video only. */
export function unanswered(e: unknown): boolean {
  return e instanceof Error && ((e as { code?: string }).code === NO_ANSWER || e.name === 'TimeoutError' || (e instanceof TypeError && e.message === 'fetch failed'));
}

/** How long a stream addon may take. An object so a test can shorten it. */
export const streamTimeout = { ms: 12_000 };
/**
 * A stream addon that just went unanswered is skipped for a minute, as a silent subtitle addon is: a dead one
 * would otherwise cost every sources load its full timeout. One that answers with an error is asked again.
 */
const streamsFailed = new TtlCache<AddonFailure>(60_000);

/** Streams from every stream addon. `queried` and `failed` list addon names in settings order, whatever order they answered in. */
export async function getStreams(type: MediaType, videoId: string): Promise<{ sources: Source[]; queried: string[]; failed: string[] }> {
  const addons = await addonsFor('stream', type);
  const results = await Promise.all(addons.map(async ({ url, m }) => {
    const ak = addonKey(url);
    const key = `${ak}|${type}/${videoId}`;
    const hit = streamCache.get(key);
    if (hit) return { name: m.name, sources: hit, failed: false };
    if (streamsFailed.get(ak) !== undefined) return { name: m.name, sources: [] as Source[], failed: true };
    const u = `${baseUrl(url)}/stream/${type}/${encodeURIComponent(videoId)}.json`;
    try {
      const sources = await streamCache.wrap(key, async () => {
        const r = await fetchAddon<{ streams: AddonStream[] }>(u, streamTimeout.ms);
        return (r.streams || []).map((s) => parseStream(s, m.name)).filter((s): s is Source => !!s);
      });
      return { name: m.name, sources, failed: false };
    } catch (e) {
      const err = errMsg(e);
      if (unanswered(e)) streamsFailed.set(ak, failure(e));
      log.warn('stream addon failed', { addon: m.name, err });
      return { name: m.name, sources: [] as Source[], failed: true };
    }
  }));
  const queried = results.map((r) => r.name);
  const failed = results.filter((r) => r.failed).map((r) => r.name);
  // dedupe on infoHash+fileIdx, keep the one with more seeders
  const map = new Map<string, Source>();
  for (const s of results.flatMap((r) => r.sources)) {
    const cur = map.get(s.id);
    if (!cur || (s.seeders || 0) > (cur.seeders || 0)) map.set(s.id, { ...s });
  }
  return { sources: flagPlaceholderSeeds([...map.values()]), queried, failed };
}

export interface AddonSubtitle { id: string; url: string; lang: string; SubEncoding?: string }

const subsCache = new TtlCache<AddonSubtitle[]>(5 * 60_000);
/**
 * A subtitle addon that just went unanswered is skipped for a minute, as a silent stream addon is: a dead one
 * would otherwise cost every subtitle list its full timeout. One that answers with an error is asked again.
 */
const subsFailed = new TtlCache<AddonFailure>(60_000);   // per addon, for Settings ("skipped, did not answer")
/** Per request, short: one slow answer must not hide another query's results (by file name versus by hash). */
const subsSkip = new TtlCache<true>(20_000);
/** How long a subtitle addon may take. An object so a test can shorten it. */
export const subtitleTimeout = { ms: 12_000 };

/** Each subtitle addon's answer. `lan`: the addon is itself on the LAN (onLan), so the files it names may be too. */
export async function getAddonSubtitles(type: MediaType, videoId: string, extra: Record<string, string | number | undefined>): Promise<{ addon: string; subs: AddonSubtitle[]; lan: boolean }[]> {
  const addons = await addonsFor('subtitles', type);
  const extraStr = Object.entries(extra).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return Promise.all(addons.map(async ({ url, m }) => {
    const ak = addonKey(url);
    const key = `${ak}|${type}/${videoId}|${extraStr}`;
    const list = async (): Promise<AddonSubtitle[]> => {
      const hit = subsCache.get(key);
      if (hit) return hit;
      if (subsSkip.get(key)) return [];
      const u = `${baseUrl(url)}/subtitles/${type}/${encodeURIComponent(videoId)}${extraStr ? `/${extraStr}` : ''}.json`;
      try {
        return await subsCache.wrap(key, async () => {
          const r = await fetchAddon<{ subtitles?: AddonSubtitle[] }>(u, subtitleTimeout.ms);
          return Array.isArray(r?.subtitles) ? r.subtitles : [];
        });
      } catch (e) {
        const err = errMsg(e);
        if (unanswered(e)) { subsFailed.set(ak, failure(e)); subsSkip.set(key, true); }
        log.warn('subtitle addon failed', { addon: m.name, err });
        return [];
      }
    };
    const subs = await list();
    return { addon: m.name, subs, lan: subs.length > 0 && await onLan(url) };
  }));
}

/**
 * The stream and subtitle failure memory, read only: addon key -> its latest unanswered request still remembered, for
 * the addons in `urls`. A failed manifest is left out: Settings asks for it again and shows that answer instead.
 */
export function skippedAddons(urls: string[]): Record<string, AddonFailure> {
  const out: Record<string, AddonFailure> = {};
  for (const url of urls) {
    const k = addonKey(url);
    const st = streamsFailed.get(k), su = subsFailed.get(k);
    const latest = st && su ? (st.failedAt >= su.failedAt ? st : su) : st || su;
    if (latest) out[k] = { failedAt: latest.failedAt, reason: latest.reason };   // copies: the memory itself stays put
  }
  return out;
}

// ------------------------------------------------------------------ catalog --
// Shortlist of public subtitle addons verified reachable on 2026-09-09, plus the subtitle addons of the official
// Stremio collection below. Stream addons are never bundled, listed or recommended: users paste their own.
// These are third-party services Kino merely queries.
const CURATED: Omit<CatalogEntry, 'installed' | 'types'>[] = [
  { url: 'https://opensubtitles-v3.strem.io/manifest.json', name: 'OpenSubtitles v3', kind: 'subtitles', recommended: true, description: 'The big one. Hash matching means subs that fit your exact file. Kino ships with it.' },
  { url: 'https://32d94ecc2689-stremio-addon-opensubtitles.baby-beamup.club/pick/manifest.json', name: 'Community OpenSubtitles', kind: 'subtitles', recommended: false, description: 'Alternative OpenSubtitles frontend when the official one is slow.' },
  { url: 'https://2ecbbd610840-addic7ed.baby-beamup.club/manifest.json', name: 'addic7ed', kind: 'subtitles', recommended: true, description: 'Series subtitles, usually the fastest to appear after an episode airs.', note: 'Series only' },
  { url: 'https://aiosubtitle.org/stremio/manifest.json', name: 'AIO Subtitle PRO', kind: 'subtitles', recommended: false, description: 'Several subtitle sources merged, with optional machine translation.' },
];
const collection = new TtlCache<CatalogEntry[]>(60 * 60_000);
interface CollectionItem { transportUrl: string; manifest: Manifest & { description?: string } }

export async function catalog(): Promise<CatalogEntry[]> {
  const installed = new Set(getState().settings.addons.map((u) => u.replace(/\/$/, '')));
  const curated: CatalogEntry[] = await Promise.all(CURATED.map(async (c) => {
    let types: string[] = ['movie', 'series'];
    try { types = (await manifest(c.url)).types || types; } catch { /* keep defaults, still listed */ }
    return { ...c, types, installed: installed.has(c.url) };
  }));
  let more: CatalogEntry[] = [];
  try {
    more = await collection.wrap('official', async () => {
      const items = await fetchJson<CollectionItem[]>('https://api.strem.io/addonscollection.json', 8000);
      const seen = new Set(CURATED.map((c) => c.url));
      const out: CatalogEntry[] = [];
      for (const it of items) {
        const m = it.manifest; const url = it.transportUrl;
        if (!url || !m || seen.has(url)) continue;
        // Subtitle addons only: one that also serves streams is left for the user to paste, like any stream addon.
        const rs = resources(m);
        const types = m.types || [];
        if (!rs.includes('subtitles') || rs.includes('stream') || !types.some((t) => t === 'movie' || t === 'series')) continue;
        if (/translate|clock|jump scare|dog die/i.test(m.name)) continue;
        seen.add(url);
        out.push({ url, name: m.name, description: (m.description || '').trim().slice(0, 160), kind: 'subtitles', types, recommended: false, installed: false });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    });
  } catch (e) { log.warn('addon collection unavailable', { err: errMsg(e) }); }
  return [...curated, ...more.map((m) => ({ ...m, installed: installed.has(m.url) }))];
}
