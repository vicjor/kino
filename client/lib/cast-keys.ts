/**
 * The keys that control a TV, shared by the Cast Center's controller and CastHotkeys (everywhere else while
 * Kino casts). Which key means what lives here; whether the action applies right now is the caller's call.
 * `key` on skip and volume is the glyph the HUD flashes next to what happened.
 */
export type CastKey =
  | { do: 'play-pause' }
  | { do: 'skip'; by: number; key: string }
  | { do: 'jump'; tenth: number }
  | { do: 'volume'; by: number; key: string }
  | { do: 'mute' }
  | { do: 'next' }
  | { do: 'subs' }
  | { do: 'stop-after' }
  | { do: 'intro' }
  | { do: 'source' }
  | { do: 'here' }
  | { do: 'stop' }
  | { do: 'keys' };

const LETTERS: Record<string, CastKey> = {
  k: { do: 'play-pause' }, j: { do: 'skip', by: -10, key: 'J' }, l: { do: 'skip', by: 10, key: 'L' },
  m: { do: 'mute' }, n: { do: 'next' }, v: { do: 'subs' }, e: { do: 'stop-after' }, i: { do: 'intro' },
  s: { do: 'source' }, h: { do: 'here' }, x: { do: 'stop' },
};

/** What a key press asks of the TV, or null when it is not a TV key. Modifiers and focus are checked by the caller. */
export function castKeyAction(e: { key: string; shiftKey?: boolean }): CastKey | null {
  const k = e.key;
  if (k === ' ') return { do: 'play-pause' };
  if (k === 'ArrowLeft') return { do: 'skip', by: e.shiftKey ? -60 : -10, key: e.shiftKey ? '⇧ ←' : '←' };
  if (k === 'ArrowRight') return { do: 'skip', by: e.shiftKey ? 60 : 10, key: e.shiftKey ? '⇧ →' : '→' };
  if (/^[0-9]$/.test(k)) return { do: 'jump', tenth: Number(k) };
  if (k === 'ArrowUp') return { do: 'volume', by: 0.05, key: '↑' };
  if (k === 'ArrowDown') return { do: 'volume', by: -0.05, key: '↓' };
  if (k === '?') return { do: 'keys' };
  return k.length === 1 ? LETTERS[k.toLowerCase()] ?? null : null;
}
