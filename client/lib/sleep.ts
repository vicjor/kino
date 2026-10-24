/** The sleep timer: off, pause at the end of this episode, or pause `min` minutes after it was set (at `until`). */
export type Sleep = null | 'episode' | { min: number; until: number };
/** A row in the sleep sheet: off, a number of minutes, or the end of this episode. */
export type SleepChoice = null | number | 'episode';

export const SLEEP_CHOICES: { label: string; choice: SleepChoice }[] = [
  { label: 'Off', choice: null },
  { label: '15 minutes', choice: 15 },
  { label: '30 minutes', choice: 30 },
  { label: '45 minutes', choice: 45 },
  { label: '1 hour', choice: 60 },
  { label: 'End of this episode', choice: 'episode' },
];

export function startSleep(c: SleepChoice, now = Date.now()): Sleep {
  return c === null || c === 'episode' ? c : { min: c, until: now + c * 60_000 };
}

/** Milliseconds until a timed sleep pauses playback; 0 when off or set to the end of the episode. */
export const sleepLeft = (s: Sleep, now = Date.now()): number => (s && s !== 'episode' ? Math.max(0, s.until - now) : 0);

/** The row that was picked, not whichever row happens to match the minutes still left. */
export function sleepPicked(s: Sleep, c: SleepChoice): boolean {
  return s === null || s === 'episode' ? s === c : s.min === c;
}

/** The small badge on the moon button: minutes left, or "End" for the end of this episode. */
export function sleepBadge(s: Sleep, leftMs: number): string | undefined {
  if (s === null) return undefined;
  return s === 'episode' ? 'End' : `${Math.max(1, Math.ceil(leftMs / 60_000))}m`;
}

/** The same in full words, for the button's label and tooltip. */
export function sleepWords(s: Sleep, leftMs: number): string {
  if (s === null) return 'Sleep timer';
  if (s === 'episode') return 'Sleep timer: pauses at the end of this episode';
  const m = Math.max(1, Math.ceil(leftMs / 60_000));
  return `Sleep timer: pauses in ${m} minute${m === 1 ? '' : 's'}`;
}

/** What a player plays, as far as the sleep timer cares. */
interface Playing { videoId: string; metaId: string }
/** The timer as the last player left it, and what that player was playing. */
export interface KeptSleep extends Playing { sleep: Sleep }

/**
 * The timer a new player starts with. Every episode and every source switch is a new player, so the timer set in the
 * last one is handed over here: "End of this episode" holds for that same episode only (another source of it), never
 * the next one; a timed one keeps counting into the next episode of the same title until it goes off.
 */
export function carrySleep(kept: KeptSleep | null, at: Playing, now = Date.now()): Sleep {
  if (!kept?.sleep) return null;
  if (kept.sleep === 'episode') return kept.videoId && kept.videoId === at.videoId ? 'episode' : null;
  return kept.metaId && kept.metaId === at.metaId && kept.sleep.until > now ? kept.sleep : null;
}

let kept: KeptSleep | null = null;
/** Remember the timer for the next player, for the page's lifetime. */
export function keepSleep(sleep: Sleep, at: Playing): void { kept = sleep ? { sleep, videoId: at.videoId, metaId: at.metaId } : null; }
/** The timer for a player opening on `at`. */
export const keptSleep = (at: Playing, now = Date.now()): Sleep => carrySleep(kept, at, now);
