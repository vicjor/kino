import type { CastStatus, MediaType } from '../../server/types.js';
import type { CastHandoff } from './api';
import type { PlayParams } from './router';

/** A file played from a magnet link: `magnet:<hash>:<idx>`. It has no title page and no addon metadata. */
export const isMagnetId = (videoId?: string): boolean => !!videoId?.startsWith('magnet:');

/** The title a video id belongs to, same rule as the server's parseVideoId: `tt1:2:3` is `tt1`, `magnet:<hash>:<idx>` is `magnet:<hash>`. */
export function metaIdOf(videoId: string): string {
  const parts = videoId.split(':');
  return isMagnetId(videoId) ? parts.slice(0, 2).join(':') : parts[0];
}

/** The series episode casting now, or null for a movie or a magnet file. The kind comes from the cast status, not the id's shape. */
export function castingEpisode(c: Pick<CastStatus, 'active' | 'type' | 'videoId'>): string | null {
  return c.active && c.type === 'series' && c.videoId && !isMagnetId(c.videoId) ? c.videoId : null;
}

/** Player params that pick up a hand-off where the TV left it. The kind comes from the cast status, not the id's shape. */
export function handoffPlayParams(type: MediaType | undefined, h: CastHandoff): PlayParams {
  const videoId = h.videoId || '';
  return {
    type: type || 'movie', videoId, metaId: videoId ? metaIdOf(videoId) : '', infoHash: h.infoHash, fileIdx: h.fileIdx,
    name: h.title, poster: h.poster, t: h.pos, magnet: isMagnetId(videoId) || undefined,
  };
}

/** Season and episode from an episode id, `tt1:2:3` is season 2, episode 3. Nothing for a movie or a magnet file. */
export function episodeOf(videoId?: string): { season: number; episode: number } | null {
  const m = videoId && !isMagnetId(videoId) ? /^[^:]+:(\d+):(\d+)$/.exec(videoId) : null;
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

/**
 * The player as the TV's remote, for Kino's own cast of a file: the mini bar grows into it. Null when nothing of
 * Kino's is on a TV.
 */
export function nowPlayingParams(c: CastStatus): PlayParams | null {
  if (!c.active || !c.infoHash) return null;
  const videoId = c.videoId || '';
  const ep = episodeOf(videoId);
  return {
    type: c.type || 'movie', videoId, metaId: videoId ? metaIdOf(videoId) : '', infoHash: c.infoHash, fileIdx: c.fileIdx,
    name: c.title || '', poster: c.poster, season: ep?.season, episode: ep?.episode, magnet: isMagnetId(videoId) || undefined, tv: true,
  };
}
