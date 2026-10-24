import type { Progress } from '../../server/types.js';

/** Below this nothing is worth resuming: the studio logo, a mis-tap. The server keeps the same floor. */
export const MIN_RESUME_SEC = 5;

/** Played to the end, as far as Kino is concerned: the last 5% is credits. Same rule as the server's isFinished. */
export function isFinished(p?: Progress | null): boolean {
  return !!p && p.dur > 0 && p.pos / p.dur > 0.95;
}

/** Where to pick a title up again, or undefined when it was barely started or already finished. */
export function resumePoint(p?: Progress | null): number | undefined {
  if (!p || !(p.pos >= MIN_RESUME_SEC)) return undefined;
  if (isFinished(p)) return undefined;
  return p.pos;
}

/** Whole minutes still to watch, at least 1, or 0 when the duration is unknown. */
export function minutesLeft(p: Progress): number {
  return p.dur ? Math.max(1, Math.round((p.dur - p.pos) / 60)) : 0;
}
