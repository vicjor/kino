import { PORT, lanIp } from '../config.js';
import { getProgress, saveProgress, MIN_PROGRESS_SEC } from '../store.js';
import { parseVideoId } from '../meta.js';
import type { CastPlayRequest, MediaType } from '../types.js';

// What a Chromecast cast (manager.ts) and a DLNA cast (dlna.ts) do the same way.

/** This server as a TV on the LAN reaches it: what every URL handed to a TV starts with. */
export function lanBase(): string { return `http://${lanIp()}:${PORT}`; }

/** An episode id ("tt123:1:2") is a series; a film id, a magnet link or none is a movie. */
export const mediaTypeOf = (videoId?: string): MediaType => (videoId?.includes(':') && !videoId.startsWith('magnet:') ? 'series' : 'movie');

/** What persistCast needs of a cast session. */
export interface CastProgress { req: Pick<CastPlayRequest, 'videoId' | 'title' | 'poster'>; duration: number; infoHash: string; fileIdx: number }

/** Save where a cast is in its video. Nothing below MIN_PROGRESS_SEC: a refused load or a TV still at 0 is not a position. */
export function persistCast(c: CastProgress, pos: number): void {
  if (!c.req.videoId || !(pos >= MIN_PROGRESS_SEC)) return;
  const { metaId, season, episode } = parseVideoId(c.req.videoId);
  const existing = getProgress(c.req.videoId);
  saveProgress({ videoId: c.req.videoId, metaId, type: season != null ? 'series' : 'movie', pos, dur: c.duration || existing?.dur || 0, updatedAt: Date.now(), name: c.req.title, poster: c.req.poster || existing?.poster, background: existing?.background, season, episode, infoHash: c.infoHash, fileIdx: c.fileIdx });
}

/**
 * The subtitle a cast starts with, as far as both transports agree: the one asked for when it is there, else the one
 * saved for this video, else the first in the language carried over from the episode before (`preferLang`) unless
 * subtitles were saved as off (null). Undefined when none of those applies: each transport has its own fallbacks after.
 */
export function pickSubtitle(tracks: readonly { id: string; lang: string }[], asked: string | null | undefined, saved: { subId?: string | null } | undefined, preferLang?: string): string | undefined {
  let id = asked && tracks.some((x) => x.id === asked) ? asked : undefined;
  if (!id && saved?.subId && tracks.some((x) => x.id === saved.subId)) id = saved.subId;
  if (!id && preferLang && saved?.subId !== null) id = tracks.find((x) => x.lang === preferLang)?.id;
  return id;
}
