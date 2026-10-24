/**
 * iOS scrubbing speeds. The playhead follows the finger along the bar at full speed; move the finger away from the bar
 * (up into the picture, or down) and it slows to half, a quarter, then fine, so a two-hour film can still be placed to
 * the second. `away` is the pointer's distance from the bar's centre line, in px.
 */
export interface ScrubSpeed { rate: number; label: string | null }
export function scrubSpeed(away: number): ScrubSpeed {
  const d = Math.abs(away);
  if (d < 60) return { rate: 1, label: null };
  if (d < 130) return { rate: 0.5, label: 'Half-speed scrubbing' };
  if (d < 200) return { rate: 0.25, label: 'Quarter-speed scrubbing' };
  return { rate: 0.1, label: 'Fine scrubbing' };
}

/** The next playhead fraction: the pointer's move along the bar (as a fraction of it), scaled by the speed, kept on the bar. */
export function scrubStep(at: number, moved: number, rate: number): number {
  return Math.min(1, Math.max(0, at + moved * rate));
}

/** What is left to watch, the way Apple's players show it on the right: "−11:36". */
export function remainingLabel(pos: number, dur: number, fmt: (s: number) => string): string {
  return `−${fmt(Math.max(0, dur - pos))}`;
}
