import { useEffect, useState, type RefObject } from 'react';
import type { PlayResponse, ReceiverInfo, Source, SubtitleTrack } from '../../../server/types.js';
import { api } from '../../lib/api';
import { setStore } from '../../lib/store';
import { navigate, playUrl, type PlayParams } from '../../lib/router';
import { sendToTv, type Tv } from '../../lib/cast-actions';

interface SendArgs {
  p: PlayParams;
  play: PlayResponse | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  phase: 'loading' | 'ready';
  playing: boolean;
  err: string;
  receivers: ReceiverInfo[] | null;
  absTime: () => number;
  activeSub: SubtitleTrack | null;
  subOffset: number;
  saveProgress: (beacon?: boolean) => void;
}

/**
 * Playing it on a TV from here: the Play on list in the corner (`destOpen`), the full picker (`castOpen`, with
 * `castSrc` when a source list sent another release there), and the nudge that pulses the button once per TV.
 */
export function useSendToTv(a: SendArgs) {
  const { p, play, videoRef, phase, playing, err, receivers, absTime, activeSub, subOffset, saveProgress } = a;
  const [castOpen, setCastOpen] = useState(false);
  const [destOpen, setDestOpen] = useState(false);   // the Play on list in the corner
  const [sending, setSending] = useState<string | null>(null);
  const [castPulse, setCastPulse] = useState<string | null>(null);   // name of the TV that is on
  const [castSrc, setCastSrc] = useState<Source | null>(null);

  // Like every cast button: the lock-screen remote arms inside this tap (sendToTv), then the TV takes over and this
  // screen turns into its remote, same route, so Back still leads where it did.
  const castTo = async (d: Tv) => {
    videoRef.current?.pause();
    setSending(d.id);
    const infoHash = castSrc?.infoHash || p.infoHash;
    const fileIdx = castSrc ? (castSrc.fileIdx ?? -1) : (p.fileIdx ?? play?.fileIdx ?? 0);
    const start = async (deviceId: string) => setStore({ cast: await api.castPlay({ deviceId, infoHash, fileIdx, videoId: p.videoId, title: p.name, poster: p.poster, startTime: absTime(), subId: castSrc ? undefined : activeSub?.id ?? null, subOffsetMs: subOffset }) });
    const ok = await sendToTv(d, start, `Playing on ${d.name}`);
    setSending(null);
    if (!ok) return;
    setCastOpen(false); setDestOpen(false);
    saveProgress(true);
    navigate(playUrl({ ...p, infoHash, fileIdx: castSrc ? castSrc.fileIdx : p.fileIdx, t: undefined, tv: true }), true);
  };

  // ---- "Cast to the TV instead?" nudge, once per TV per browser session: the Cast button pulses for a few seconds ----
  useEffect(() => { if (!castPulse) return; const t = window.setTimeout(() => setCastPulse(null), 6000); return () => window.clearTimeout(t); }, [castPulse]);
  useEffect(() => {
    if (phase !== 'ready' || !playing || err) return;
    const tv = (receivers || []).find((r) => r.online && !r.audioOnly && !r.kino && !(r.media && r.media.state === 'PLAYING'));
    if (!tv) return;
    const key = `kino.nudge.${tv.id}`;
    if (sessionStorage.getItem(key)) return;
    const t = window.setTimeout(() => {
      if (!videoRef.current || videoRef.current.paused) return;
      sessionStorage.setItem(key, '1');
      setCastPulse(tv.name);
    }, 20000);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, playing, receivers?.length]);

  return { castOpen, setCastOpen, destOpen, setDestOpen, sending, castPulse, setCastPulse, setCastSrc, castTo };
}
