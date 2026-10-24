import type { Settings } from '../../server/types.js';

const GB = 1024 ** 3;

/** A settings field that saves when you leave it: what it shows for the stored settings, and the change for what was typed (null: none). */
interface Field { show: (s: Settings) => string; patch: (typed: string) => Partial<Settings> | null }

/**
 * A number field in whole `unit`s, at least `min`. An empty or garbled field changes nothing: clearing the cache
 * limit to type a new one must not save a default and evict the cache. The server keeps its own upper limits.
 */
function num(k: 'autoNextDelaySec' | 'cacheCapBytes' | 'minFreeBytes', min: number, unit = 1): Field {
  return {
    show: (s) => String(Math.round(s[k] / unit)),
    patch: (v) => { const n = Number(v); return v.trim() && Number.isFinite(n) ? { [k]: Math.max(min, Math.round(n)) * unit } as Partial<Settings> : null; },
  };
}

/** Clearing a text field sends '': JSON drops undefined, so the server would keep the old value. */
export const FIELDS = {
  tmdbApiKey: { show: (s) => s.tmdbApiKey || '', patch: (v) => ({ tmdbApiKey: v.trim() }) },
  omdbApiKey: { show: (s) => s.omdbApiKey || '', patch: (v) => ({ omdbApiKey: v.trim() }) },
  haWebhookUrl: { show: (s) => s.haWebhookUrl || '', patch: (v) => ({ haWebhookUrl: v.trim() }) },
  autoNextDelaySec: num('autoNextDelaySec', 3),
  cacheCapBytes: num('cacheCapBytes', 1, GB),
  minFreeBytes: num('minFreeBytes', 1, GB),
} satisfies Record<string, Field>;
export type FieldKey = keyof typeof FIELDS;

/**
 * The one save a field makes when you leave it (blur or Enter), never one per keystroke: typing 15 into the cache
 * limit must not save 1 GB first and evict the cache down to it. Null when what was typed shows what is saved already.
 */
export function fieldChange(k: FieldKey, typed: string, s: Settings): Partial<Settings> | null {
  const f: Field = FIELDS[k], patch = f.patch(typed);
  return patch && f.show({ ...s, ...patch }) !== f.show(s) ? patch : null;
}
