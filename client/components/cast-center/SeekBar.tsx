import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { ReceiverInfo } from '../../../server/types.js';
import { fmtTime } from '../../lib/format';
import type { CmdFn } from './shared';

/** Scrubber with live position; drag to seek (only when the app speaks the media namespace). */
export function SeekBar({ r, onCmd, at, dur: durIn, onSeek }: { r: ReceiverInfo; onCmd: CmdFn; at?: number; dur?: number; onSeek?: (t: number) => void }) {
  const [seek, setSeek] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const m = r.media; const dur = durIn ?? m?.duration ?? 0;
  if (!m || !dur) return null;
  const pos = seek != null ? seek * dur : (at ?? m.currentTime ?? 0);
  const ratio = (e: RPointerEvent) => { const b = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)); };
  return (
    <div ref={bar} className={`cc-seek${seek != null ? ' dragging' : ''}`} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pos)}
      onPointerDown={(e) => { e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); setSeek(ratio(e)); }}
      onPointerMove={(e) => { if (seek == null || !bar.current!.hasPointerCapture(e.pointerId)) return; setSeek(ratio(e)); }}
      onPointerUp={(e) => { if (seek == null) return; bar.current!.releasePointerCapture(e.pointerId); if (onSeek) onSeek(seek * dur); else void onCmd(r.id, 'seek', { time: seek * dur }); setSeek(null); }}
      onPointerCancel={() => setSeek(null)}>
      <i style={{ width: `${(pos / dur) * 100}%` }} />
      <b style={{ left: `${(pos / dur) * 100}%` }} />
      <span className="cc-time">{fmtTime(pos)}</span><span className="cc-time right">-{fmtTime(Math.max(0, dur - pos))}</span>
    </div>
  );
}
