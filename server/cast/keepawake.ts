/**
 * Google's Default Media Receiver quits 20 minutes into a pause and takes the cast with it. A seek to the same
 * second restarts that clock, so Kino nudges it while paused, but only so long that it still quits an hour in.
 */
export const RECEIVER_PAUSE_MS = 20 * 60_000;
export const NUDGE_EVERY_MS = 10 * 60_000;
export const PAUSE_CAP_MS = 60 * 60_000;

/** Nudge now? `pausedAt`: when the pause began; `lastNudge`: the last one (0 for none). */
export function shouldNudge(pausedAt: number, lastNudge: number, now: number): boolean {
  return now - Math.max(pausedAt, lastNudge) >= NUDGE_EVERY_MS && now + RECEIVER_PAUSE_MS <= pausedAt + PAUSE_CAP_MS;
}
