import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore, setStore, toast } from '../lib/store';
import { inIntro, trackJump, learnable, JUMP_GAP_MS, type IntroWindow, type Jump } from '../lib/intro';
import { castingEpisode, metaIdOf } from '../lib/handoff';
import type { CastStatus } from '../../server/types.js';
import '../styles/upnext.css';

export interface IntroQuery { infoHash: string; fileIdx: number; videoId?: string; metaId: string }
const keyOf = (q: IntroQuery | null) => (q ? `${q.infoHash}:${q.fileIdx}:${q.videoId || ''}` : '');

/** Where the opening titles sit in the file playing now, asked once per file. */
export function useIntro(q: IntroQuery | null): IntroWindow | null {
  const [w, setW] = useState<IntroWindow | null>(null);
  const k = keyOf(q);
  useEffect(() => {
    setW(null);
    if (!q) return;
    let dead = false;
    api.intro(q).then((r) => { if (!dead) setW(r); }).catch(() => undefined);
    return () => { dead = true; };
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  return w;
}

/**
 * Learns from you skipping the titles by hand (the seek bar, or a few taps on +10 s early in an episode),
 * so the next episode of the show offers the button. `reset` after a skip Kino suggested itself.
 */
export function useIntroLearner(q: IntroQuery | null) {
  const jump = useRef<Jump | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const qRef = useRef(q); qRef.current = q;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onJump = useCallback((from: number, to: number) => {
    jump.current = trackJump(jump.current, from, to, Date.now());
    window.clearTimeout(timer.current);
    if (!jump.current) return;
    timer.current = window.setTimeout(() => {
      const j = jump.current; const cur = qRef.current; jump.current = null;
      if (cur && learnable(j)) api.introLearn({ ...cur, start: j.from, end: j.to }).catch(() => undefined);
    }, JUMP_GAP_MS + 500);
  }, []);
  const reset = useCallback(() => { jump.current = null; window.clearTimeout(timer.current); }, []);
  return { onJump, reset };
}

/** The pill itself, shared by the player and the cast card. */
export function SkipIntroButton({ onSkip, className = '' }: { onSkip: () => void; className?: string }) {
  return <button className={`skip-intro ${className}`.trim()} onClick={(e) => { e.stopPropagation(); onSkip(); }}>Skip intro</button>;
}

/** The series casting now, as an intro lookup. Null for movies and magnet links. */
export function castIntroQuery(c: CastStatus): IntroQuery | null {
  const videoId = castingEpisode(c);
  if (!videoId || !c.infoHash || c.fileIdx == null) return null;
  return { infoHash: c.infoHash, fileIdx: c.fileIdx, videoId, metaId: metaIdOf(videoId) };
}

/**
 * Casting a series: every phone gets the Skip intro pill while the titles run on the TV,
 * in the corner where Up next shows at the credits.
 */
export function CastSkipIntro() {
  const cast = useStore((s) => s.cast);
  const w = useIntro(castIntroQuery(cast));
  const [busy, setBusy] = useState(false);
  if (!w || cast.upNext || cast.state === 'IDLE' || !inIntro(w, cast.currentTime || 0)) return null;
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    try { setStore({ cast: await api.castSeek(w.end!) }); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return <div className="cast-skip-intro"><SkipIntroButton onSkip={() => void skip()} className={busy ? 'busy' : ''} /></div>;
}
