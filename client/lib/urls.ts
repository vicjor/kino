// Hash-route builders and readers. No DOM at import, so tests can load them; router.ts re-exports them.

export function titleUrl(type: string, id: string, videoId?: string): string {
  return `/title/${type}/${id}${videoId ? `?v=${encodeURIComponent(videoId)}` : ''}`;
}
export interface PlayParams {
  type: string; videoId: string; metaId: string; infoHash: string; fileIdx?: number;
  name: string; poster?: string; background?: string; season?: number; episode?: number; t?: number; magnet?: boolean;
  /** The player as the TV's remote: what plays on the TV, this screen shows and steers it. */
  tv?: boolean;
}
export function playUrl(p: PlayParams): string {
  const q = new URLSearchParams();
  // A flag that is off is left out: readPlayParams reads a missing one as off.
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v));
  return `/play?${q.toString()}`;
}
export function readPlayParams(q: URLSearchParams): PlayParams {
  const num = (k: string) => (q.get(k) == null ? undefined : Number(q.get(k)));
  return {
    type: q.get('type') || 'movie', videoId: q.get('videoId') || '', metaId: q.get('metaId') || '',
    infoHash: q.get('infoHash') || '', fileIdx: num('fileIdx'), name: q.get('name') || '',
    poster: q.get('poster') || undefined, background: q.get('background') || undefined,
    season: num('season'), episode: num('episode'), t: num('t'), magnet: q.get('magnet') === 'true',
    ...(q.get('tv') === 'true' ? { tv: true } : {}),
  };
}
