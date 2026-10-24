import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { fmtTime } from '../lib/format';
import { scrubSpeed, scrubStep, remainingLabel } from '../lib/scrub';
import '../styles/media.css';

export interface Mark { t: number; label: string }

/**
 * The timeline, shared by the player and the TV remote. A tap lands where it is; a drag then moves the playhead
 * with the finger, and slower as the finger moves away from the bar (iOS scrubbing speeds), so the bar doubles as a
 * fine control. The bar thickens under the pointer. Elapsed on the left, what is left on the right.
 */
export function Scrubber({ cur, dur, buffered = [], marks = [], onSeek, disabled }: {
  cur: number; dur: number; buffered?: [number, number][]; marks?: Mark[]; onSeek: (t: number) => void; disabled?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; along: number; f: number } | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [speed, setSpeed] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  /*
   * Where the pointer is along the bar and how far off it, from the bar's own box on screen: in the phone's fake
   * landscape the bar runs top to bottom, and reading X across a bar that is really vertical would turn a small move
   * into a huge jump. rotate(90deg) points the bar's start at the top; rotate(-90deg) at the bottom.
   */
  const measure = (e: { clientX: number; clientY: number }) => {
    const r = bar.current!.getBoundingClientRect();
    if (r.width >= r.height) return { along: (e.clientX - r.left) / r.width, away: e.clientY - (r.top + r.height / 2), len: r.width };
    const m = new DOMMatrix(getComputedStyle(bar.current!.closest('.player') || bar.current!).transform);
    const along = m.b < 0 ? (r.bottom - e.clientY) / r.height : (e.clientY - r.top) / r.height;
    return { along, away: e.clientX - (r.left + r.width / 2), len: r.height };
  };
  const onDown = (e: RPointerEvent) => {
    if (disabled || !dur || (e.pointerType === 'mouse' && e.button !== 0)) return;
    bar.current!.setPointerCapture(e.pointerId);
    const at = measure(e);
    const f = Math.min(1, Math.max(0, at.along));
    drag.current = { id: e.pointerId, along: at.along, f };
    setScrub(f);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) { if (e.pointerType === 'mouse' && dur && !disabled) setHover(Math.min(1, Math.max(0, measure(e).along))); return; }
    const at = measure(e);
    const s = scrubSpeed(at.away);
    d.f = scrubStep(d.f, at.along - d.along, s.rate);
    d.along = at.along;
    setScrub(d.f); setSpeed(s.label);
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setScrub(null); setSpeed(null);
    if (e.type !== 'pointercancel') onSeek(d.f * dur);
  };

  const shown = scrub != null ? scrub * dur : cur;
  const pct = dur ? Math.min(100, (shown / dur) * 100) : 0;
  return (
    <div className={`scrub${scrub != null ? ' active' : ''}${disabled ? ' off' : ''}`}>
      <div className="scrub-bar" ref={bar} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(shown)}
        aria-valuetext={`${fmtTime(shown)} of ${fmtTime(dur)}`} tabIndex={disabled ? -1 : 0}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setHover(null)}>
        <div className="scrub-track">
          {dur ? buffered.map(([a, b], i) => <i key={i} className="scrub-buf" style={{ left: `${(a / dur) * 100}%`, width: `${((b - a) / dur) * 100}%` }} />) : null}
          <i className="scrub-played" style={{ width: `${pct}%` }} />
        </div>
        {dur ? marks.map((m) => (
          <button key={m.t} className="mark" style={{ left: `${(m.t / dur) * 100}%` }} aria-label={`${m.label}, go there`}
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSeek(m.t); }}>
            <span className="mark-label">{m.label}</span>
          </button>
        )) : null}
        {scrub != null ? <span className="scrub-bubble" style={{ left: `${pct}%` }}>{fmtTime(shown)}</span>
          : hover != null && dur ? <span className="scrub-bubble hover" style={{ left: `${hover * 100}%` }}>{fmtTime(hover * dur)}</span> : null}
      </div>
      <div className="scrub-times" aria-hidden="true">
        <span>{fmtTime(shown)}</span>
        {speed ? <span className="scrub-speed">{speed}</span> : null}
        <span>{dur ? remainingLabel(shown, dur, fmtTime) : '--:--'}</span>
      </div>
    </div>
  );
}
