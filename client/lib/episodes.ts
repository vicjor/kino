import type { Episode, Progress, Source } from '../../server/types.js';
import { isFinished } from './progress.js';

/** Season numbers in order, specials (season 0) last. */
export function seasonsOf(videos: Episode[]): number[] {
  const set = new Set(videos.map((v) => v.season));
  const arr = [...set].filter((s) => s > 0).sort((a, b) => a - b);
  if (set.has(0)) arr.push(0);
  return arr;
}
export function sortedEpisodes(videos: Episode[]): Episode[] {
  return [...videos].sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
}
/** Out already. No date counts as out, same as the player's next-episode check. */
export function isReleased(e: Episode, now = Date.now()): boolean {
  return !e.released || !(Date.parse(e.released) > now);
}
/** The episodes that drive the pick: the regular ones, or the specials when a show has nothing else. */
function pickable(videos: Episode[]): Episode[] {
  const all = sortedEpisodes(videos);
  const regular = all.filter((e) => e.season > 0);
  return regular.length ? regular : all;
}
/**
 * The episode a series page should land on: the one you are in the middle of, else the one after the last you
 * finished, as long as it has aired. Caught up on a show still airing, that is the last one you watched.
 */
export function nextUp(videos: Episode[], progress: Record<string, Progress>, now = Date.now()): Episode | undefined {
  const eps = pickable(videos);
  let lastIdx = -1;
  let lastAt = 0;
  eps.forEach((e, i) => { const p = progress[e.id]; if (p && p.updatedAt > lastAt) { lastAt = p.updatedAt; lastIdx = i; } });
  if (lastIdx < 0) return eps.find((e) => isReleased(e, now)) || eps[0];
  const last = eps[lastIdx];
  if (!isFinished(progress[last.id])) return last;
  const next = eps[lastIdx + 1];
  return next && isReleased(next, now) ? next : last;
}
/**
 * Caught up: the pick is an episode you finished and nothing after it has aired. Gives the next episode still to
 * air (undefined when none is listed) so the page can say when it lands; null when there is something new to watch.
 */
export function caughtUp(videos: Episode[], progress: Record<string, Progress>, now = Date.now()): { upcoming?: Episode } | null {
  const pick = nextUp(videos, progress, now);
  if (!pick || !isFinished(progress[pick.id])) return null;
  const eps = pickable(videos);
  const later = eps.slice(eps.findIndex((e) => e.id === pick.id) + 1);
  if (later.some((e) => isReleased(e, now))) return null;
  return { upcoming: later[0] };
}

/**
 * The release to play an episode from: the same group as the episode before it (a binge keeps one release, so the
 * intro, the subtitles and the quality stay the same), else the one Kino picked, else the first.
 */
export function episodeSource(sources: Source[], auto?: string, binge?: string | null): Source | undefined {
  return (binge ? sources.find((s) => s.bingeGroup === binge) : undefined) || sources.find((s) => s.id === auto) || sources[0];
}
