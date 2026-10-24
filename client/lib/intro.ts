/** Skip intro, the client half: when to show the button, and telling a skip over the titles from any other jump. */
export interface IntroWindow { start?: number; end?: number; source: 'chapter' | 'subtitles' | 'learned' | 'none'; confidence: 'high' | 'medium' | 'low' | 'none' }
/** A run of forward jumps close together in time: three taps on +10 s is one skip of thirty. */
export interface Jump { from: number; to: number; at: number }

export const JUMP_GAP_MS = 4000;
// Same limits the server checks (server/media/intro.ts isIntroJump).
const BY = 15 * 60, MIN = 15, MAX = 180;

/** The button shows from the start of the titles until a few seconds before they end. */
export function inIntro(w: IntroWindow | null | undefined, t: number): boolean {
  return !!w && w.confidence !== 'none' && w.start != null && w.end != null && t >= w.start - 1 && t < w.end - 3;
}

/** Fold one seek into the running jump. A jump back, or one far from where the last left off, starts over. */
export function trackJump(prev: Jump | null, from: number, to: number, now: number): Jump | null {
  if (to <= from) return null;
  if (prev && now - prev.at < JUMP_GAP_MS && Math.abs(from - prev.to) < 5) return { from: prev.from, to, at: now };
  return { from, to, at: now };
}

export function learnable(j: Jump | null): j is Jump {
  return !!j && j.from >= 0 && j.from < BY && j.to - j.from >= MIN && j.to - j.from <= MAX;
}
