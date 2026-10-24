import { useEffect, useRef, useState } from 'react';
import type { Episode } from '../../server/types.js';

/**
 * The parent re-renders several times a second and hands a fresh onPlay each time, so the countdown keeps
 * its own deadline and reads onPlay from a ref: a re-render never restarts or stalls it.
 */
export function Countdown({ next, seconds, auto, credits, onPlay, onCancel }: { next: Episode; seconds: number; auto: boolean; credits?: boolean; onPlay: (manual: boolean) => void; onCancel: () => void }) {
  const [left, setLeft] = useState(seconds);
  const playRef = useRef(onPlay); playRef.current = onPlay;
  const fired = useRef(false);
  useEffect(() => {
    setLeft(seconds);
    if (!auto) return;
    const deadline = Date.now() + seconds * 1000;
    const t = window.setInterval(() => {
      const l = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(l);
      if (l > 0 || fired.current) return;
      fired.current = true; window.clearInterval(t); playRef.current(false);
    }, 250);
    return () => window.clearInterval(t);
  }, [auto, seconds]);
  return (
    <div className="countdown">
      {next.thumbnail ? <img src={next.thumbnail} alt="" /> : null}
      <div className="cd-text">
        <div className="cd-label">{credits ? 'Credits · Up next' : 'Up next'}</div>
        <div className="cd-title">S{next.season} E{next.episode} {next.title || ''}</div>
        <div className="cd-actions">
          <button className="btn primary small" onClick={() => onPlay(true)}>{auto ? `Play in ${left}` : 'Play next'}</button>
          <button className="btn ghost small" onClick={onCancel}>Not now</button>
        </div>
      </div>
    </div>
  );
}
