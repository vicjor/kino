import { isSafeKey } from './errors.js';
import { adoptSubId } from './subs/ids.js';
import type { State } from './store.js';
import type { Settings, Progress, CastHistoryEntry } from './types.js';
import type { IntroSample } from './media/intro.js';

/*
 * One gate for settings, whoever writes them: PUT /api/settings and a restored backup. Pure, so every rule
 * has a test. A field that is present but wrong is left out and named in `errors`; PUT refuses the whole
 * change with those words, a restore keeps the rest of the backup.
 */

const GB = 1024 ** 3;
/** Most free space Kino can be told to keep, the Settings field's own maximum. Past the disk's size every play is refused. */
export const MAX_MIN_FREE_BYTES = 100 * GB;
/** Same rule as addAddon: an http(s) address of a manifest.json, stremio:// read as https://. */
const ADDON_RE = /^https?:\/\/.+manifest\.json/;
/** Entries kept per Cast receiver, live (store.addCastHistory) and from a restored backup. */
export const CAST_HISTORY_CAP = 50;

export function addonUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const u = v.trim().replace(/^stremio:\/\//, 'https://');
  return ADDON_RE.test(u) && URL.canParse(u) ? u : undefined;
}
function webhookUrl(v: string): string | undefined {
  const u = v.trim();
  if (!URL.canParse(u)) return undefined;
  const p = new URL(u).protocol;
  return p === 'http:' || p === 'https:' ? u : undefined;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const strings = (v: unknown[]) => v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);

const MSG: Partial<Record<keyof Settings, string>> = {
  addons: 'Addon addresses must be http or https links to a manifest.json.',
  haWebhookUrl: 'The webhook URL must start with http:// or https://.',
  cacheCapBytes: 'The cache limit must be at least 1 GB.',
  minFreeBytes: 'Space to keep free must be between 0 and 100 GB.',
};

export interface CleanSettings { settings: Partial<Settings>; errors: string[] }

/**
 * The known, valid fields of a settings patch. A key set to undefined means "clear it" (the webhook URL and the
 * API keys, sent as "" or null). Numbers keep today's bounds: cache at least 1 GB, free space 0 to 100 GB, subtitle
 * size clamped to 50..250 percent, next-episode countdown to 0..60 s.
 */
export function sanitizeSettings(raw: unknown): CleanSettings {
  const out: Partial<Settings> = {}; const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings: out, errors: ['Settings must be an object.'] };
  const b = raw as Record<string, unknown>;
  const bad = (k: keyof Settings) => { errors.push(MSG[k] || `That is not a valid value for ${k}.`); };
  const has = (k: keyof Settings) => Object.hasOwn(b, k) && b[k] !== undefined;

  if (has('subLangs')) Array.isArray(b.subLangs) ? (out.subLangs = [...new Set(strings(b.subLangs).map((x) => x.toLowerCase()))]) : bad('subLangs');
  if (has('cacheCapBytes')) finite(b.cacheCapBytes) && b.cacheCapBytes >= GB ? (out.cacheCapBytes = b.cacheCapBytes) : bad('cacheCapBytes');
  if (has('minFreeBytes')) finite(b.minFreeBytes) && b.minFreeBytes >= 0 && b.minFreeBytes <= MAX_MIN_FREE_BYTES ? (out.minFreeBytes = b.minFreeBytes) : bad('minFreeBytes');
  if (has('haWebhookUrl')) {
    const v = b.haWebhookUrl;
    if (v === null || v === '') out.haWebhookUrl = undefined;
    else { const u = typeof v === 'string' ? webhookUrl(v) : undefined; u ? (out.haWebhookUrl = u) : bad('haWebhookUrl'); }
  }
  for (const k of ['omdbApiKey', 'tmdbApiKey'] as const) if (has(k)) {
    const v = b[k];
    if (v === null || typeof v === 'string') out[k] = (v || '').trim() || undefined; else bad(k);
  }
  for (const k of ['autoSubs', 'autoNext', 'onboarded'] as const) if (has(k)) typeof b[k] === 'boolean' ? (out[k] = b[k]) : bad(k);
  if (has('subFontSize')) finite(b.subFontSize) ? (out.subFontSize = clamp(b.subFontSize, 50, 250)) : bad('subFontSize');
  if (has('autoNextDelaySec')) finite(b.autoNextDelaySec) ? (out.autoNextDelaySec = clamp(b.autoNextDelaySec, 0, 60)) : bad('autoNextDelaySec');
  if (has('addons')) {
    if (!Array.isArray(b.addons)) bad('addons');
    else {
      const ok = b.addons.map(addonUrl);
      out.addons = [...new Set(ok.filter((u): u is string => !!u))];
      if (ok.some((u) => !u)) bad('addons');
    }
  }
  return { settings: out, errors };
}

/** A saved progress entry with everything the rails and players read: also the store's check on load. */
export const isProgress = (v: unknown): v is Progress => {
  const p = v as Progress;
  return !!p && typeof p === 'object' && finite(p.pos) && p.pos >= 0 && finite(p.dur) && p.dur >= 0 && finite(p.updatedAt)
    && typeof p.metaId === 'string' && isSafeKey(p.metaId) && (p.type === 'movie' || p.type === 'series') && typeof p.name === 'string';
};
export const isListEntry = (v: unknown): v is { id: string } => !!v && typeof v === 'object' && isSafeKey((v as { id?: unknown }).id);
export const isCastEntry = (v: unknown): v is CastHistoryEntry => {
  const e = v as CastHistoryEntry;
  return !!e && typeof e === 'object' && finite(e.ts) && typeof e.app === 'string' && typeof e.title === 'string';
};
export const isIntro = (v: unknown): v is IntroSample => !!v && typeof v === 'object' && finite((v as IntroSample).start) && finite((v as IntroSample).end);
/**
 * A restored entry's saved subtitle, made to match this install's secret.key (adoptSubId). One that cannot be is
 * dropped, not set to null: null means you turned subtitles off, while unset with the language kept lets the player
 * pick a track in that language. Changes the entry in place: mergeBackup hands it a copy.
 */
function adoptSub(p: Progress, root?: Buffer): Progress {
  if (p.subId != null) { const id = adoptSubId(p.subId, root); if (id) p.subId = id; else delete p.subId; }
  return p;
}
/** Own, safe keys of a plain object from a backup; anything else is no entries. */
const entries = (m: unknown): [string, unknown][] => (m && typeof m === 'object' && !Array.isArray(m) ? Object.entries(m).filter(([k]) => isSafeKey(k)) : []);

export type Backup = Partial<Record<keyof State, unknown>>;
/** Anything that looks like a Kino backup: an object with progress, settings or a watchlist. */
export const isBackup = (b: unknown): b is Backup => !!b && typeof b === 'object' && !Array.isArray(b) && ['progress', 'settings', 'watchlist'].some((k) => !!(b as Record<string, unknown>)[k]);

/**
 * Merge a backup into the state, in place. Settings go through sanitizeSettings (addons are added to yours, never
 * replace them). Progress: the newer entry per video wins, its subtitle id signed with this install's key (`root`,
 * secret.key unless a test passes one). Lists add what is missing. Cast history merges per device without duplicates,
 * newest first. Learned credits and intro points fill in titles this install has not learned yet; what it has
 * learned stays. Restoring the same backup twice changes nothing the second time.
 */
export function mergeBackup(s: State, b: Backup, root?: Buffer): State {
  if (b.settings && typeof b.settings === 'object') {
    const { addons, ...rest } = sanitizeSettings(b.settings).settings;
    Object.assign(s.settings, rest);
    if (addons) s.settings.addons = [...new Set([...(s.settings.addons || []), ...addons])];
  }
  for (const [k, v] of entries(b.progress)) {
    if (isProgress(v) && (!Object.hasOwn(s.progress, k) || s.progress[k].updatedAt < v.updatedAt)) s.progress[k] = adoptSub({ ...v, videoId: k }, root);
  }
  if (Array.isArray(b.watchlist)) for (const w of b.watchlist) if (isListEntry(w) && !s.watchlist.some((x) => x.id === w.id)) s.watchlist.push(w as State['watchlist'][number]);
  if (Array.isArray(b.following)) for (const f of b.following) if (isListEntry(f) && !s.following.some((x) => x.id === f.id)) s.following.push(f as State['following'][number]);
  for (const [k, v] of entries(b.castHistory)) {
    if (!Array.isArray(v)) continue;
    const have = Object.hasOwn(s.castHistory, k) ? s.castHistory[k] : [];
    const seen = new Set<string>(); const key = (e: CastHistoryEntry) => `${e.ts}|${e.app}|${e.title}`;
    s.castHistory[k] = [...have, ...v.filter(isCastEntry)].filter((e) => !seen.has(key(e)) && !!seen.add(key(e))).sort((a, c) => c.ts - a.ts).slice(0, CAST_HISTORY_CAP);
  }
  for (const [k, v] of entries(b.credits)) {
    const ok = Array.isArray(v) ? v.filter(finite).slice(-5) : [];
    if (ok.length && !Object.hasOwn(s.credits, k)) s.credits[k] = ok;
  }
  for (const [k, v] of entries(b.intros)) {
    const ok = Array.isArray(v) ? v.filter(isIntro).slice(-5) : [];
    if (ok.length && !Object.hasOwn(s.intros, k)) s.intros[k] = ok;
  }
  return s;
}
