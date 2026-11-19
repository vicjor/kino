import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Episode, PickOutcome, PlayResponse, TorrentStats } from '../../../server/types.js';
import { api, errorCode } from '../../lib/api';
import { toast } from '../../lib/store';
import { endedEarlyWords, endedEarlyDetail, stallWords, slowWords, stutterWords, toastWords, MEDIA } from '../../lib/play-errors';
import { fmtTime } from '../../lib/format';
import { bigJumpBack, clampSeek, inRanges, nextPopupAt, rangePairs, stallWaitMs, type Mark } from '../../lib/playback';
import type { PlayParams } from '../../lib/router';
import type { Fail, MediaRefs } from './useSession';
import type { Notice, ShowNotice } from './PlayerChrome';

interface MediaEventsArgs extends Pick<MediaRefs, 'videoRef' | 'hlsOffsetRef'> {
  play: PlayResponse | null;
  err: string;
  stats: TorrentStats | null;
  volume: number;
  muted: boolean;
  fail: Fail;
  totalDur: () => number;
  saveProgress: (beacon?: boolean) => void;
  lastSave: RefObject<number>;
  lastPos: RefObject<{ pos: number; dur: number } | null>;
  setDur: Dispatch<SetStateAction<number>>;
  setBuffering: Dispatch<SetStateAction<boolean>>;
  autoRetries: RefObject<number>;
  watched: RefObject<{ sec: number; last: number }>;
  outcomeRef: RefObject<(kind: PickOutcome) => void>;
  next: Episode | null;
  nextShown: RefObject<boolean>;
  setShowNext: (b: boolean) => void;
  setEnded: (b: boolean) => void;
  creditsRef: RefObject<{ at?: number; confidence: string } | null>;
}

/**
 * The video element's events, turned into player state: where it is, what is buffered, playing or waiting, a save
 * every ten seconds, the up-next popup at the credits, and the failures ("ended" well before the end is one).
 */
export function useMediaEvents(a: MediaEventsArgs) {
  const { videoRef, hlsOffsetRef, play, err, stats, volume, muted, fail, totalDur, saveProgress, lastSave, lastPos, setDur, setBuffering, autoRetries, watched, outcomeRef, next, nextShown, setShowNext, setEnded, creditsRef } = a;
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const lastSeekAt = useRef(0);   // a seek buffers too: that is not the stream stuttering
  const statsRef = useRef(stats); statsRef.current = stats;
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    v.volume = volume; v.muted = muted;
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    const upd = () => {
      setCur(v.currentTime + hlsOffsetRef.current);
      lastPos.current = { pos: v.currentTime + hlsOffsetRef.current, dur: totalDur() };
      if (!play?.probe?.duration && isFinite(v.duration)) setDur(v.duration);
      setBuffered(rangePairs(v.buffered, hlsOffsetRef.current));
      if (ms && 'setPositionState' in ms) { const dd = totalDur(); if (dd && isFinite(dd)) try { ms.setPositionState({ duration: dd, position: Math.min(dd, v.currentTime + hlsOffsetRef.current), playbackRate: v.playbackRate || 1 }); } catch { /* ignore */ } }
      if (playing && Date.now() - lastSave.current > 10000) saveProgress();
      const d = totalDur();
      const at = nextPopupAt(creditsRef.current, d);
      if (next && d && v.currentTime + hlsOffsetRef.current >= at && !nextShown.current) { nextShown.current = true; setShowNext(true); }
    };
    const setPB = (st: MediaSessionPlaybackState) => { const m = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession; if (m) m.playbackState = st; };
    const onPlay = () => { setPlaying(true); setBuffering(false); setPB('playing'); };
    const onProgressOk = () => {
      if (v.currentTime > 15) autoRetries.current = 0;
      const w = watched.current; const d = v.currentTime - w.last;
      if (w.last >= 0 && d > 0 && d < 2 && !v.paused) w.sec += d;
      w.last = v.currentTime;
    };
    const onPause = () => { setPlaying(false); saveProgress(); setPB('paused'); };
    // A jump is a decision about where you are: save it now, not up to ten seconds later.
    const onSeeked = () => { upd(); saveProgress(); };
    const onSeeking = () => { lastSeekAt.current = Date.now(); };
    const onWait = () => setBuffering(true);
    const onCanPlay = () => setBuffering(false);
    const onEnded = () => {
      // "ended" well before the end is not the end: the transcoder died or the download ran dry.
      const d = totalDur(); const at = v.currentTime + hlsOffsetRef.current;
      if (d && d - at > 20) {
        if (play?.mode === 'direct') outcomeRef.current('ended-early');   // the download ran dry
        const w = endedEarlyWords(play?.mode === 'direct');
        fail(w.msg, { hint: w.hint, detail: endedEarlyDetail(at, d, statsRef.current), retry: true });
        return;
      }
      setPlaying(false); setEnded(true); saveProgress(); if (next && !nextShown.current) { nextShown.current = true; setShowNext(true); }
    };
    const onErr = () => {
      const e = v.error; if (!e || err || e.code === 1) return;
      const w = e.code === 2 ? MEDIA.lost : e.code === 3 ? MEDIA.broken : MEDIA.format;
      fail(w.msg, { hint: w.hint, detail: e.message, retry: e.code === 2, media: e.code === 3 || e.code === 4 });
    };
    v.addEventListener('timeupdate', onProgressOk); v.addEventListener('timeupdate', upd); v.addEventListener('progress', upd); v.addEventListener('durationchange', upd);
    v.addEventListener('play', onPlay); v.addEventListener('playing', onPlay); v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWait); v.addEventListener('canplay', onCanPlay); v.addEventListener('ended', onEnded); v.addEventListener('error', onErr); v.addEventListener('seeked', onSeeked); v.addEventListener('seeking', onSeeking);
    return () => {
      v.removeEventListener('seeked', onSeeked); v.removeEventListener('seeking', onSeeking);
      v.removeEventListener('timeupdate', onProgressOk); v.removeEventListener('timeupdate', upd); v.removeEventListener('progress', upd); v.removeEventListener('durationchange', upd);
      v.removeEventListener('play', onPlay); v.removeEventListener('playing', onPlay); v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWait); v.removeEventListener('canplay', onCanPlay); v.removeEventListener('ended', onEnded); v.removeEventListener('error', onErr);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, playing, next, err, volume, muted, saveProgress, totalDur, fail]);
  return { playing, cur, setCur, buffered, lastSeekAt };
}

interface SeekArgs extends MediaRefs {
  play: PlayResponse | null;
  attach: (url: string, mode: PlayResponse['mode'], timeOffset: number, startLocal?: number) => void;
  totalDur: () => number;
  absTime: () => number;
  lastSeekAt: RefObject<number>;
  setBuffering: Dispatch<SetStateAction<boolean>>;
  setCur: Dispatch<SetStateAction<number>>;
  addMark: (m: Mark) => void;
}

/**
 * Seeking on the file's timeline: inside what the video already has it just moves; outside an HLS session's reach
 * the server starts a new session there. A big jump back leaves a mark where you were.
 */
export function useSeek(a: SeekArgs) {
  const { videoRef, hlsRef, sessionRef, hlsOffsetRef, play, attach, totalDur, absTime, lastSeekAt, setBuffering, setCur, addMark } = a;
  const seekTo = useCallback(async (t: number) => {
    const v = videoRef.current; if (!v || !play) return;
    lastSeekAt.current = Date.now();
    t = clampSeek(t, totalDur());
    // Big jump backwards (a stray tap on the seek bar): remember where you were.
    const from = absTime();
    if (bigJumpBack(from, t)) addMark({ t: from, label: `You were at ${fmtTime(from)}` });
    if (play.mode === 'direct') { v.currentTime = t; return; }
    const local = t - hlsOffsetRef.current;
    let ok = inRanges(v.seekable, local);
    if (!ok && hlsRef.current) {
      const h = hlsRef.current.hls;
      const details = h?.levels?.[h.currentLevel]?.details;
      if (details && local >= 0 && local <= details.totalduration) ok = true;
    }
    if (ok && local >= 0) { v.currentTime = local; return; }
    if (!sessionRef.current) return;
    setBuffering(true);
    try {
      const r = await api.hlsSeek(sessionRef.current, t);
      sessionRef.current = r.sessionId;
      attach(r.url, play.mode, r.timeOffset, Math.max(0, t - r.timeOffset));
      setCur(t);
    } catch (e) { toast(toastWords(errorCode(e), (e as Error).message), 'error'); setBuffering(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, attach, totalDur, absTime]);
  const skip = useCallback((d: number) => seekTo(absTime() + d), [seekTo, absTime]);
  const togglePlay = useCallback(() => { const v = videoRef.current; if (!v) return; if (v.paused) v.play().catch(() => undefined); else v.pause(); }, [videoRef]);
  return { seekTo, skip, togglePlay };
}

type SrcOpen = false | { reason?: string };

interface StallArgs {
  p: PlayParams;
  videoRef: RefObject<HTMLVideoElement | null>;
  phase: 'loading' | 'ready';
  err: string;
  play: PlayResponse | null;
  stats: TorrentStats | null;
  buffering: boolean;
  playing: boolean;
  lastSeekAt: RefObject<number>;
  outcomeRef: RefObject<(kind: PickOutcome) => void>;
  srcOpen: SrcOpen;
  setSrcOpen: (o: SrcOpen) => void;
  showNotice: ShowNotice;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
}

/**
 * Stall and slow detection: say why, offer a way out. Stuck buffering for a while opens the stall sheet; well before
 * that, three rebuffers in two minutes or a download slower than the file's bitrate nudge toward another source.
 */
export function useStallWatch(a: StallArgs) {
  const { p, videoRef, phase, err, play, stats, buffering, playing, lastSeekAt, outcomeRef, srcOpen, setSrcOpen, showNotice, setNotice } = a;
  const [stall, setStall] = useState<{ reason: string; hint?: string } | null>(null);
  const stallSnooze = useRef(0);
  const rebuffers = useRef<number[]>([]);       // timestamps of stalls while playing
  const weakNudged = useRef(0);
  // Torrent stats arrive every 2 s; read them through a ref so a stats update never restarts the wait.
  const diagnose = useRef(() => stallWords(play, stats));
  diagnose.current = () => stallWords(play, stats);
  useEffect(() => {
    const wait = stallWaitMs({ ready: phase === 'ready', err: !!err, open: !!stall, buffering, snoozedUntil: stallSnooze.current, now: Date.now(), hasPlay: !!play });
    if (wait == null) return;
    const t = window.setTimeout(() => {
      const v = videoRef.current;
      if (!v || (play && v.paused && v.currentTime > 0)) return;   // user paused, not a stall
      setStall(diagnose.current());
      outcomeRef.current('stall');
    }, wait);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffering, phase, err, stall, play]);
  // Soft nudge well before the stall sheet: three rebuffers in two minutes, or a
  // download that cannot keep up with the file's bitrate while we are playing.
  useEffect(() => {
    if (!buffering || phase !== 'ready' || !play || !videoRef.current || videoRef.current.currentTime < 5) return;
    if (Date.now() - lastSeekAt.current < 10_000) return;   // you jumped: the wait is the jump, not stutter
    const now = Date.now();
    rebuffers.current = [...rebuffers.current.filter((t) => now - t < 120_000), now];
    if (rebuffers.current.length >= 3 && now - weakNudged.current > 180_000 && !stall && !srcOpen && !p.magnet && p.videoId) {
      weakNudged.current = now;
      const w = stutterWords(p.type === 'series');
      showNotice({ text: w.text, action: { label: 'Switch source', run: () => { setNotice(null); setSrcOpen({ reason: w.reason }); } } }, 15000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffering]);
  useEffect(() => {
    if (!playing || !stats || !play || p.magnet || !p.videoId) return;
    const need = play.sizeBytes && play.probe?.duration ? play.sizeBytes / play.probe.duration : 0;
    if (!need) return;
    const slow = stats.numPeers === 0 || stats.downloadSpeed < need * 0.7;
    if (!slow || stats.progress >= 0.999) return;
    const t = window.setTimeout(() => {
      if (Date.now() - weakNudged.current < 180_000 || stall || srcOpen) return;
      weakNudged.current = Date.now();
      const w = slowWords(stats.numPeers, stats.downloadSpeed, need);
      outcomeRef.current('slow');
      showNotice({ text: w.text, action: { label: 'Switch source', run: () => { setNotice(null); setSrcOpen({ reason: w.reason }); } } }, 15000);
    }, 25_000);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, stats?.downloadSpeed, stats?.numPeers]);
  // "Wait" and closing the sheet both give it another minute and a half before it asks again.
  const snoozeStall = () => { stallSnooze.current = Date.now() + 90_000; setStall(null); };
  return { stall, snoozeStall };
}

interface MediaSessionArgs extends Pick<MediaRefs, 'videoRef' | 'hlsOffsetRef'> {
  p: PlayParams;
  next: Episode | null;
  playNext: () => Promise<void>;
}

/** Lock-screen and notification controls (MediaSession), like Spotify. */
export function useMediaSession({ p, videoRef, hlsOffsetRef, next, playNext }: MediaSessionArgs) {
  useEffect(() => {
    const nav = navigator as Navigator & { mediaSession?: MediaSession };
    if (!nav.mediaSession || typeof MediaMetadata === 'undefined') return;
    const art = p.poster || p.background;
    nav.mediaSession.metadata = new MediaMetadata({
      title: p.name || 'Kino',
      artist: p.type === 'series' && p.season != null ? `Season ${p.season}, Episode ${p.episode}` : 'Kino',
      album: 'Kino',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { nav.mediaSession!.setActionHandler(a, h); } catch { /* unsupported */ } };
    const v = () => videoRef.current;
    set('play', () => v()?.play());
    set('pause', () => v()?.pause());
    set('seekbackward', (d) => { const el = v(); if (el) el.currentTime = Math.max(0, el.currentTime - (d.seekOffset || 10)); });
    set('seekforward', (d) => { const el = v(); if (el) el.currentTime = el.currentTime + (d.seekOffset || 10); });
    set('seekto', (d) => { const el = v(); if (el && d.seekTime != null) el.currentTime = d.seekTime - hlsOffsetRef.current; });
    set('nexttrack', next ? () => void playNext() : null);
    return () => { for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack'] as MediaSessionAction[]) set(a, null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.name, p.poster, p.background, p.type, p.season, p.episode, next, playNext]);
}
