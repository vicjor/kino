import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { PickOutcome, SubtitleTrack } from '../../../server/types.js';
import { api } from '../../lib/api';
import type { PlayParams } from '../../lib/router';

/**
 * The pick log learns what became of a release picked from a source list (server/picks.ts). The server ties it to the
 * pick and keeps one line per kind; a release no list pick names logs nothing. `watched` counts the seconds of video
 * played here, seeks and reloads left out (the media events add to it).
 */
export function usePickLog(p: PlayParams, absTime: () => number) {
  const watched = useRef({ sec: 0, last: -1 });
  const outcome = useCallback((kind: PickOutcome) => {
    if (!p.videoId || p.magnet) return;
    void api.logOutcome({ videoId: p.videoId, chosen: `${p.infoHash}:${p.fileIdx ?? -1}`, outcome: kind, pos: Math.round(absTime()), watchedSec: Math.round(watched.current.sec) });
  }, [p, absTime]);
  const outcomeRef = useRef(outcome); outcomeRef.current = outcome;
  return { watched, outcome, outcomeRef };
}

interface ProgressArgs {
  p: PlayParams;
  videoRef: RefObject<HTMLVideoElement | null>;
  absTime: () => number;
  totalDur: () => number;
  movedOn: RefObject<boolean>;
  subRef: RefObject<SubtitleTrack | null>;
  subSettled: RefObject<boolean>;
  offsetRef: RefObject<number>;
  saveRef: RefObject<(beacon?: boolean) => void>;
}

/**
 * Where you are in this video, saved: every ten seconds while playing (the media events), on pause, seek and leaving,
 * and as a beacon when the page hides. `saveRef` always holds the latest save, for callers that outlive a render.
 */
export function useProgress(a: ProgressArgs) {
  const { p, videoRef, absTime, totalDur, movedOn, subRef, subSettled, offsetRef, saveRef } = a;
  const lastSave = useRef(0);
  // The last position seen on the timeline. React detaches videoRef before the unmount cleanup runs, so the
  // save on leaving reads this instead of the element (which is exactly the save that used to be lost).
  const lastPos = useRef<{ pos: number; dur: number } | null>(null);
  const saveProgress = useCallback((beacon = false) => {
    if (!p.videoId) return;
    const v = videoRef.current;
    const d = v ? totalDur() : lastPos.current?.dur ?? 0;
    const pos = movedOn.current && d > 0 ? d : v ? absTime() : lastPos.current?.pos ?? 0;
    if (pos < 5) return;
    const sub = subSettled.current ? { subId: subRef.current?.id ?? null, subLang: subRef.current?.lang, subOffsetMs: offsetRef.current } : {};
    const body = { videoId: p.videoId, metaId: p.metaId || p.videoId, type: (p.type as 'movie' | 'series'), pos, dur: d, name: p.name, poster: p.poster, background: p.background, season: p.season, episode: p.episode, infoHash: p.infoHash, fileIdx: p.fileIdx, ...sub };
    if (beacon) api.beaconProgress(body); else api.putProgress(body).catch(() => undefined);
    lastSave.current = Date.now();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, absTime, totalDur]);
  saveRef.current = saveProgress;
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') saveProgress(true); };
    const onPageHide = () => saveProgress(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onPageHide); };
  }, [saveProgress]);
  return { saveProgress, lastSave, lastPos };
}
