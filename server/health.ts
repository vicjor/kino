/** What a restart would interrupt, as /health counts it: viewers only, never background downloads or parked transcoders. */
export interface Watching { cast: boolean; hlsSessions: number; streams: number }

/** The raw counts /health reads. `transcoderStreams` (ffmpeg's own reads) and `held` (download holds) are part of `openStreams`. */
export interface Counts { openStreams: number; transcoderStreams: number; held: number; sessions: readonly { parked?: boolean }[]; cast: boolean }

/**
 * Viewers only. An HLS session counts once, as a session, and only while it is not parked: a parked ffmpeg (SIGSTOP)
 * keeps its /api/file read open for a rewind, nobody is watching it. A download hold resumes after a restart.
 */
export function watching(c: Counts): Watching {
  return { streams: Math.max(0, c.openStreams - c.transcoderStreams - c.held), hlsSessions: c.sessions.filter((s) => !s.parked).length, cast: c.cast };
}

/**
 * Someone is watching: a Cast or DLNA session, a transcoder or a file stream.
 * /health reports it as `busy`; make deploy-local and deploy-safe read that one flag (scripts/health-state.sh).
 */
export function isBusy(w: Watching): boolean { return w.cast || w.hlsSessions > 0 || w.streams > 0; }
