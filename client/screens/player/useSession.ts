import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { PlayResponse, PickOutcome } from '../../../server/types.js';
import { api, errorCode, isOffline } from '../../lib/api';
import { resumePoint } from '../../lib/progress';
import { target, caps } from '../../lib/player-caps';
import { attachMedia, type Attached } from '../../lib/hls-attach';
import { setStore, toast } from '../../lib/store';
import { onSse } from '../../lib/sse';
import { startWords, stoppedWords, toastWords, autoRetry, transcodeFallback, MEDIA } from '../../lib/play-errors';
import { fmtTime, langName } from '../../lib/format';
import type { PlayParams } from '../../lib/router';
import type { Mark } from '../../lib/playback';
import type { ErrInfo, Notice, ShowNotice } from './PlayerChrome';

/** The refs one play shares between its hooks. Each is made once, in LocalPlayer, and handed down. */
export interface MediaRefs {
  videoRef: RefObject<HTMLVideoElement | null>;
  hlsRef: RefObject<Attached | null>;
  sessionRef: RefObject<string | null>;   // the HLS session in use, if any
  hlsOffsetRef: RefObject<number>;        // HLS session start offset (s)
}

/** `code` is the server's (ErrorCode): a full disk or a broken program is shown at once, no quiet retries. */
interface FailInfo extends ErrInfo { code?: string; media?: boolean }
export type Fail = (msg: string, info?: FailInfo) => void;

interface SessionArgs extends MediaRefs {
  p: PlayParams;
  renderCues: (ms: number) => void;
  offsetRef: RefObject<number>;
  showNotice: ShowNotice;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  setBuffering: Dispatch<SetStateAction<boolean>>;
  setDur: Dispatch<SetStateAction<number>>;
  setMarks: Dispatch<SetStateAction<Mark[]>>;
  outcomeRef: RefObject<(kind: PickOutcome) => void>;
  saveRef: RefObject<(beacon?: boolean) => void>;
}

/**
 * One play from request to teardown: asks the server to play the file, attaches what it answers (resuming where you
 * were), and fails in one place. A failure the browser cannot play is retried converted; a server that went away is
 * waited for and retried quietly, twice; anything else shows. Retrying starts the same file again from where it was.
 */
export function useSession(a: SessionArgs) {
  const { p, videoRef, hlsRef, sessionRef, hlsOffsetRef, renderCues, offsetRef, showNotice, setNotice, setBuffering, setDur, setMarks, outcomeRef, saveRef } = a;
  const [play, setPlay] = useState<PlayResponse | null>(null);
  const [err, setErr] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [errInfo, setErrInfo] = useState<ErrInfo | null>(null);
  const retryFrom = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A server restart (deploy, crash, sleep) kills the stream. Before showing an error,
  // wait for /health to answer again and pick up where we were, silently, twice.
  const autoRetries = useRef(0);
  const retryRef = useRef<() => void>(() => undefined);
  // The file the browser could not play as is or copied: from then on the server converts it (once, play-errors.ts).
  const fileKey = `${p.infoHash}:${p.fileIdx ?? -1}`;
  const keyRef = useRef(fileKey); keyRef.current = fileKey;
  const converted = useRef<string | null>(null);
  const playRef = useRef(play); playRef.current = play;
  const fail = useCallback<Fail>((msg, info = {}) => {
    if (transcodeFallback(playRef.current?.mode, !!info.media, converted.current === keyRef.current)) {
      console.info('[kino] could not play this, converting it instead', { mode: playRef.current?.mode, detail: info.detail });
      converted.current = keyRef.current;
      showNotice({ text: 'Converting this video for this browser…' }, 6000);
      // From where it was; a file that never started (no metadata) resumes as on open.
      const at = (videoRef.current?.currentTime || 0) + hlsOffsetRef.current;
      retryFrom.current = at > 1 ? at : null; setErr(''); setErrInfo(null); setAttempt((n) => n + 1);
      return;
    }
    if (info.code === 'no-peers' || info.code === 'unreadable') outcomeRef.current(info.code);
    if (info.retry && autoRetry(info.code) && autoRetries.current < 2) {
      autoRetries.current++;
      setBuffering(true);
      showNotice({ text: 'Reconnecting…' }, 25_000);
      const until = Date.now() + 25_000;
      // Still no answer after all that: Kino is out of reach, whatever the first failure looked like.
      const probe = () => api.health().then(() => { setNotice(null); retryRef.current(); }).catch(() => { if (Date.now() < until) setTimeout(probe, 1500); else { setNotice(null); setErr(MEDIA.lost.msg); setErrInfo({ hint: MEDIA.lost.hint, detail: info.detail, retry: true, lost: true }); setBuffering(false); } });
      setTimeout(probe, 1200);
      return;
    }
    setErr((cur) => cur || msg);
    setErrInfo((cur) => cur || info);
    setBuffering(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const retry = () => { retryFrom.current = (videoRef.current?.currentTime || 0) + hlsOffsetRef.current; setErr(''); setErrInfo(null); setAttempt((a) => a + 1); };
  retryRef.current = retry;

  // ---- attach media ----
  const attach = useCallback((url: string, mode: PlayResponse['mode'], timeOffset: number, startLocal = 0, autoplay = true) => {
    const v = videoRef.current!;
    hlsOffsetRef.current = timeOffset;
    renderCues(offsetRef.current);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const onReady = () => { if (startLocal > 0) v.currentTime = startLocal; if (autoplay) v.play().catch(() => undefined); };
    hlsRef.current = attachMedia(v, url, { native: mode === 'direct', onReady, onFail: fail });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderCues, fail]);

  const startAt = useCallback(async (resp: PlayResponse, t: number) => {
    if (resp.mode !== 'direct' && t > 5 && resp.sessionId) {
      try {
        const r = await api.hlsSeek(resp.sessionId, t);
        sessionRef.current = r.sessionId;
        // The session starts at the keyframe before t; step forward to t itself.
        attach(r.url, resp.mode, r.timeOffset, Math.max(0, t - r.timeOffset));
        return;
      } catch { /* fall through and start from 0 */ }
    }
    attach(resp.url, resp.mode, 0, resp.mode === 'direct' ? t : 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach]);

  // ---- init ----
  useEffect(() => {
    let dead = false;
    setErr(''); setErrInfo(null); setMarks([]); setPhase('loading'); setPlay(null); setBuffering(true);
    setStore({ lockRemote: null }); // local playback owns the media session now
    (async () => {
      try {
        const resp = await api.play({ infoHash: p.infoHash, fileIdx: p.fileIdx, target: target(), videoId: p.videoId, caps: caps(), forceTranscode: converted.current === fileKey || undefined });
        if (dead) return;
        setPlay(resp);
        sessionRef.current = resp.sessionId || null;
        if (resp.probe?.duration) setDur(resp.probe.duration);
        const resumeFrom = retryFrom.current; retryFrom.current = null;
        let start = resumeFrom ?? p.t ?? 0;
        if (resumeFrom == null && p.t == null && p.videoId) {
          // Always resume where you were; "Start over" is one tap away.
          const prog = await api.progress(p.videoId).catch(() => null);
          if (dead) return;
          const at = resumePoint(prog);
          if (at != null) {
            start = at;
            setMarks([{ t: at, label: `Resumed at ${fmtTime(at)}` }]);
          }
        }
        setPhase('ready');
        await startAt(resp, start);
      } catch (e) {
        if (dead) return;
        if (isOffline(e)) { fail(MEDIA.lost.msg, { hint: MEDIA.lost.hint, retry: true, lost: true }); return; }
        const code = errorCode(e);
        const w = startWords(code);
        fail(w.msg, { hint: w.hint, detail: (e as Error).message, retry: true, code });
      }
    })();
    return () => { dead = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.infoHash, p.fileIdx, p.videoId, attempt]);

  // Keep the transcoder session alive while this player is open (paused players fetch nothing).
  useEffect(() => {
    const t = window.setInterval(() => { if (sessionRef.current) void api.hlsPing(sessionRef.current); }, 45_000);
    return () => window.clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => {
    // unmount cleanup
    saveRef.current(true);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (sessionRef.current) api.hlsClose(sessionRef.current);
    const v = videoRef.current; if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    setStore({ stats: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (p.infoHash) api.torrentStats(p.infoHash).then((s) => setStore({ stats: s })).catch(() => undefined); }, [p.infoHash]);

  // The server knows when a transcoder dies. Without this the player would just sit there.
  useEffect(() => onSse('hls.state', (st) => {
    if (st.state !== 'error' || st.sessionId !== sessionRef.current) return;
    const w = stoppedWords(st.code);
    fail(w.msg, { hint: w.hint, detail: st.error, retry: true, code: st.code });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fail]);

  return { play, setPlay, err, errInfo, phase, attempt, fail, retry, attach, startAt, autoRetries, converted, fileKey };
}

/** Change audio track: the server remuxes with that track (direct only if it is the first one), from where you are. */
export function useAudioSwitch(a: Pick<MediaRefs, 'sessionRef'> & { p: PlayParams; play: PlayResponse | null; setPlay: (r: PlayResponse) => void; setBuffering: (b: boolean) => void; startAt: (r: PlayResponse, t: number) => Promise<void>; absTime: () => number; converted: RefObject<string | null>; fileKey: string }) {
  const { p, play, setPlay, sessionRef, setBuffering, startAt, absTime, converted, fileKey } = a;
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const audioTracks = play?.probe?.audio || [];
  const pickAudio = async (index: number) => {
    if (!play || index === play.audioIndex) { setAudioOpen(false); return; }
    setAudioBusy(true);
    const at = absTime();
    try {
      if (sessionRef.current) { void api.hlsClose(sessionRef.current); sessionRef.current = null; }
      const resp = await api.play({ infoHash: p.infoHash, fileIdx: p.fileIdx, target: target(), videoId: p.videoId, caps: caps(), audioTrack: index, forceTranscode: converted.current === fileKey || undefined });
      setPlay(resp);
      sessionRef.current = resp.sessionId || null;
      setBuffering(true);
      await startAt(resp, at);
      setAudioOpen(false);
      const t = resp.probe?.audio.find((x) => x.index === index);
      toast(`Audio: ${t ? langName(t.lang || 'und') : 'track ' + index}`);
    } catch (e) { toast(toastWords(errorCode(e), (e as Error).message), 'error'); } finally { setAudioBusy(false); }
  };
  return { audioTracks, audioOpen, setAudioOpen, audioBusy, pickAudio };
}
