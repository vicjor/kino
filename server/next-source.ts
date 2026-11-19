import type { Source } from './types.js';

/** What played the episode before: its torrent (a season pack holds the next episode too) and its binge group. */
export interface PlayedFrom { infoHash?: string; bingeGroup?: string | null }

/**
 * The release to play the next episode from, the same rule in the browser player and on a TV (cast/manager.ts
 * auto-next). A binge keeps one release, so the intro, the subtitles and the quality stay the same: the same pack
 * first, then the same binge group, else the automatic pick. Only a source worth playing (score above 0) is followed.
 * Undefined when nothing is worth playing (no automatic pick either, score.ts pickAuto). No imports: the client uses it.
 */
export function nextSource(sources: Source[], auto: string | undefined, from: PlayedFrom = {}): Source | undefined {
  const ok = (s: Source) => s.score > 0;
  return (from.infoHash ? sources.find((s) => s.infoHash === from.infoHash && ok(s)) : undefined)
    || (from.bingeGroup ? sources.find((s) => s.bingeGroup === from.bingeGroup && ok(s)) : undefined)
    || (auto ? sources.find((s) => s.id === auto) : undefined);
}
