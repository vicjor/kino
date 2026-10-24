/**
 * Where does the opening title sequence sit? Like the credits, nobody tells us, so we estimate:
 *   chapter    a chapter called Intro / Opening / Main titles in the first part of the file
 *   subtitles  a window you skipped before, found again in this episode as the quiet stretch before the
 *              dialogue picks up (cold opens vary in length, the gap between titles and first line does not)
 *   learned    the window you skipped before, as is, when earlier episodes agree on where it starts
 * Seconds throughout. A window is only ever offered as a button; nothing skips by itself.
 */
import { median, type Chapter } from './credits.js';

/** One skip you made: from where to where, and how long after `end` the next line of dialogue came. */
export interface IntroSample { start: number; end: number; anchor?: number }
type IntroSource = 'chapter' | 'subtitles' | 'learned' | 'none';
export interface IntroEstimate { start?: number; end?: number; source: IntroSource; confidence: 'high' | 'medium' | 'low' | 'none' }
/** A line of dialogue, in seconds. */
export interface Line { start: number; end: number; text?: string }

/** Intros live near the start. Past this point a forward jump is you skipping a scene, not the titles. */
const INTRO_BY = 15 * 60;
const INTRO_MIN = 15;
const INTRO_MAX = 180;
const INTRO_TITLE = /\b(intro|opening|op|title sequence|main titles?|opening (credits|titles))\b/i;

/** A forward jump that looks like skipping the titles: early in the file, between a quarter minute and three minutes. */
export function isIntroJump(from: number, to: number): boolean {
  const d = to - from;
  return from >= 0 && from < INTRO_BY && d >= INTRO_MIN && d <= INTRO_MAX;
}

export function introFromChapters(chapters: Chapter[] | undefined, duration: number): { start: number; end: number } | undefined {
  if (!chapters?.length) return undefined;
  const c = chapters.find((x) => x.title && INTRO_TITLE.test(x.title) && x.start < Math.min(INTRO_BY, (duration || Infinity) * 0.4) && x.end - x.start >= 10 && x.end - x.start <= 300);
  return c ? { start: c.start, end: c.end } : undefined;
}

/** Song lyrics and sound cues are not dialogue: an intro with a subtitled theme song is still an intro. */
const NOT_DIALOGUE = /^[\s♪♫#*\-[\]()]*$|^\s*[♪♫#]|^\s*[[(][^\])]*[\])]\s*$/;
export function dialogue(lines: Line[]): Line[] {
  return lines.filter((l) => !NOT_DIALOGUE.test((l.text || 'x').replace(/<[^>]+>/g, ''))).sort((a, b) => a.start - b.start);
}

/** Quiet stretches in the first part of the file: [end of one line, start of the next], the file start counting as a line. */
export function gaps(lines: Line[], until = INTRO_BY + INTRO_MAX): [number, number][] {
  const out: [number, number][] = [];
  let last = 0;
  for (const l of lines) {
    if (last > until) break;
    if (l.start - last >= INTRO_MIN) out.push([last, l.start]);
    last = Math.max(last, l.end);
  }
  return out;
}

/** Seconds from `end` to the next line of dialogue, when that is close enough to mean something. */
export function anchorFor(lines: Line[], end: number): number | undefined {
  const next = lines.find((l) => l.start >= end - 1);
  if (!next) return undefined;
  const a = next.start - end;
  return a >= -1 && a <= 120 ? Math.max(0, a) : undefined;
}

export function introFromSamples(samples: IntroSample[] | undefined, lines?: Line[]): IntroEstimate | undefined {
  const ok = (samples || []).filter((s) => isIntroJump(s.start, s.end));
  if (!ok.length) return undefined;
  const len = median(ok.map((s) => s.end - s.start));
  const at = median(ok.map((s) => s.start));
  const anchors = ok.map((s) => s.anchor).filter((a): a is number => a != null);
  if (lines?.length && anchors.length) {
    const a = median(anchors);
    // Each quiet stretch long enough to hold the titles gives a candidate; the one closest to where you skipped before wins.
    const cands = gaps(lines).map(([g0, g1]) => ({ start: g1 - a - len, end: g1 - a, g0 })).filter((c) => c.start >= c.g0 - 5 && c.start >= 0 && c.start < INTRO_BY);
    const best = cands.sort((x, y) => Math.abs(x.start - at) - Math.abs(y.start - at))[0];
    if (best) return { start: Math.max(0, Math.round(best.start)), end: Math.round(best.end), source: 'subtitles', confidence: ok.length >= 2 ? 'high' : 'medium' };
  }
  // Without dialogue to line up against, only trust the plain window when the earlier episodes agree on it.
  const starts = ok.map((s) => s.start);
  if (Math.max(...starts) - Math.min(...starts) > 20) return undefined;
  return { start: Math.round(at), end: Math.round(at + len), source: 'learned', confidence: ok.length >= 2 ? 'high' : 'low' };
}

export function estimateIntro(input: { duration: number; chapters?: Chapter[]; lines?: Line[]; samples?: IntroSample[] }): IntroEstimate {
  const ch = introFromChapters(input.chapters, input.duration);
  if (ch) return { ...ch, source: 'chapter', confidence: 'high' };
  const s = introFromSamples(input.samples, input.lines ? dialogue(input.lines) : undefined);
  if (s?.end != null && (!input.duration || s.end < input.duration * 0.5)) return s;
  return { source: 'none', confidence: 'none' };
}

/** Keep the last few skips per show, so a changed title sequence in a new season takes over quickly. */
export function pushIntro(existing: IntroSample[] | undefined, s: IntroSample, keep = 5): IntroSample[] {
  const r = { start: Math.round(s.start), end: Math.round(s.end), ...(s.anchor != null ? { anchor: Math.round(s.anchor * 10) / 10 } : {}) };
  return [...(existing || []), r].slice(-keep);
}
