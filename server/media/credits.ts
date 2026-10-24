/**
 * Where do the end credits start? Nobody tells us, so we estimate from what the file and the
 * viewer give away, best signal first:
 *   learned    what you pressed "next" at in earlier episodes of the same show (two or more)
 *   chapter    a chapter called Credits / Ending / Outro, or the last chapter when it sits in the tail
 *   subtitles  the last line of dialogue; credits follow a few seconds later
 *   learned    a single earlier press
 * Anything else falls back to the player's fixed 30 seconds before the end.
 */
export interface Chapter { start: number; end: number; title?: string }
type CreditsSource = 'learned' | 'chapter' | 'subtitles' | 'none';
export interface CreditsEstimate { at?: number; source: CreditsSource; confidence: 'high' | 'medium' | 'low' | 'none' }

const CREDIT_TITLE = /credit|ending|end title|outro|closing/i;

export function fromChapters(chapters: Chapter[] | undefined, duration: number): { at: number; confidence: 'high' | 'medium' } | undefined {
  if (!chapters?.length || !duration) return undefined;
  const named = chapters.find((c) => c.title && CREDIT_TITLE.test(c.title) && c.start > duration * 0.5);
  if (named) return { at: named.start, confidence: 'high' };
  const last = chapters[chapters.length - 1];
  if (chapters.length >= 3 && last.start >= duration * 0.88 && duration - last.start >= 20) return { at: last.start, confidence: 'medium' };
  return undefined;
}

/** Last cue end in seconds; credits rarely carry dialogue, so they begin shortly after it. */
export function fromSubtitles(lastCueEndSec: number | undefined, duration: number): { at: number; confidence: 'medium' | 'low' } | undefined {
  if (lastCueEndSec == null || !duration) return undefined;
  const tail = duration - lastCueEndSec;
  if (tail < 25 || tail > 15 * 60) return undefined;
  return { at: lastCueEndSec + 2, confidence: tail <= 8 * 60 ? 'medium' : 'low' };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function fromLearned(offsets: number[] | undefined, duration: number): { at: number; confidence: 'high' | 'low' } | undefined {
  if (!offsets?.length || !duration) return undefined;
  const off = median(offsets);
  if (off < 10 || off > duration * 0.5) return undefined;
  return { at: duration - off, confidence: offsets.length >= 2 ? 'high' : 'low' };
}

export function estimateCredits(input: { duration: number; chapters?: Chapter[]; lastCueEndSec?: number; learnedOffsets?: number[] }): CreditsEstimate {
  const learned = fromLearned(input.learnedOffsets, input.duration);
  if (learned?.confidence === 'high') return { at: learned.at, source: 'learned', confidence: 'high' };
  const ch = fromChapters(input.chapters, input.duration);
  if (ch) return { at: ch.at, source: 'chapter', confidence: ch.confidence };
  const sub = fromSubtitles(input.lastCueEndSec, input.duration);
  if (sub) return { at: sub.at, source: 'subtitles', confidence: sub.confidence };
  if (learned) return { at: learned.at, source: 'learned', confidence: 'low' };
  return { source: 'none', confidence: 'none' };
}

/** Keep the last few presses per show; a viewer who skips early once should not drag the estimate for ever. */
export function pushLearned(existing: number[] | undefined, offset: number, keep = 5): number[] {
  return [...(existing || []), Math.round(offset)].slice(-keep);
}
