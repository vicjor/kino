import { useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import '../styles/media.css';

/**
 * A level you drag, iOS style: a filled capsule with no thumb that thickens under the finger. The value follows the
 * pointer 1:1 from wherever it lands; `onChange` reports every move (`final` false) and the release (`final` true), so
 * a TV can be told now and then without a request per pixel. The arrow keys step it by 5 %.
 */
export function LevelSlider({ value, onChange, label, before, after, className = '' }: {
  value: number; onChange: (v: number, final: boolean) => void; label: string; before?: ReactNode; after?: ReactNode; className?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const at = (e: { clientX: number }) => { const r = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const onDown = (e: RPointerEvent) => { if (e.pointerType === 'mouse' && e.button !== 0) return; e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); const v = at(e); setDrag(v); onChange(v, false); };
  const onMove = (e: RPointerEvent) => { if (drag == null || !bar.current!.hasPointerCapture(e.pointerId)) return; const v = at(e); setDrag(v); onChange(v, false); };
  const onUp = (e: RPointerEvent) => { if (drag == null) return; const v = e.type === 'pointercancel' ? drag : at(e); setDrag(null); onChange(v, true); };
  const shown = drag ?? value;
  const step = (d: number) => onChange(Math.round(Math.min(1, Math.max(0, value + d)) * 20) / 20, true);
  return (
    <div className={`level ${className}${drag != null ? ' active' : ''}`.trim()}>
      {before}
      <div className="level-bar" ref={bar} role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(0.05); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(-0.05); } }}>
        <div className="level-track"><i style={{ width: `${shown * 100}%` }} /></div>
      </div>
      {after}
    </div>
  );
}
