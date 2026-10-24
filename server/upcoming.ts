import { DAY_MS } from './config.js';
import type { Episode, MetaPreview, Upcoming } from './types.js';

/** The next episode of a show still to air within the horizon, and how many more of that season follow it. */
export function nextAiring(videos: Episode[] | undefined, now: number, horizonDays = 60): { episode: Episode; more: number } | undefined {
  const future = (videos || []).filter((v) => v.season > 0 && v.released && Date.parse(v.released) > now)
    .sort((a, b) => Date.parse(a.released!) - Date.parse(b.released!) || a.season - b.season || a.episode - b.episode);
  const e = future[0];
  if (!e || Date.parse(e.released!) > now + horizonDays * DAY_MS) return undefined;
  return { episode: e, more: future.filter((v) => v.season === e.season && v.id !== e.id).length };
}

/**
 * Coming up: for every show you follow or have been watching, the next episode on its way, soonest first.
 * One per show, so a weekly show is one card that moves along, not a wall of dates.
 */
export function comingUp(shows: { show: MetaPreview; videos?: Episode[] }[], now: number, horizonDays = 60): Upcoming[] {
  const seen = new Set<string>();
  const out: Upcoming[] = [];
  for (const { show, videos } of shows) {
    if (seen.has(show.id)) continue;
    seen.add(show.id);
    const n = nextAiring(videos, now, horizonDays);
    if (n) out.push({ show, episode: n.episode, more: n.more });
  }
  return out.sort((a, b) => Date.parse(a.episode.released!) - Date.parse(b.episode.released!));
}
