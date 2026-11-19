import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { ReceiverInfo } from '../../../server/types.js';
import { IconVol, IconMute } from '../Icons';
import type { CmdFn } from './shared';

/** Pressable volume bar (iOS style filled track). Shared by tile and detail. */
export function VolumeBar({ r, big, onCmd }: { r: ReceiverInfo; big?: boolean; onCmd: CmdFn }) {
  const [vol, setVol] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const lastSend = useRef(0);
  const holdUntil = useRef(0);
  // Hold the locally chosen level briefly so a stale server push cannot yank the bar back.
  const level = vol != null || Date.now() < holdUntil.current ? (vol ?? r.volume) : r.volume;
  const ratio = (e: RPointerEvent) => { const b = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)); };
  const send = (v: number) => { lastSend.current = Date.now(); holdUntil.current = Date.now() + 1500; void onCmd(r.id, 'volume', { level: Math.round(v * 100) / 100 }); };
  const onDown = (e: RPointerEvent) => { if (!r.online) return; e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); setVol(ratio(e)); };
  const onMove = (e: RPointerEvent) => { if (vol == null || !bar.current!.hasPointerCapture(e.pointerId)) return; const v = ratio(e); setVol(v); if (Date.now() - lastSend.current > 140) send(v); };
  const onUp = (e: RPointerEvent) => { if (vol == null) return; bar.current!.releasePointerCapture(e.pointerId); send(vol); setTimeout(() => setVol(null), 1200); };
  return (
    <div ref={bar} className={`cc-vol${vol != null ? ' dragging' : ''}${big ? ' big' : ''}`} role="slider" aria-label={`${r.name} volume`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="cc-vol-fill" style={{ width: `${(r.muted ? 0 : level) * 100}%` }} />
      <button className="cc-vol-ico" aria-label={r.muted ? 'Unmute' : 'Mute'} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void onCmd(r.id, 'volume', { muted: !r.muted }); }}>{r.muted ? <IconMute /> : <IconVol />}</button>
      <span className="cc-vol-pct">{Math.round(level * 100)}</span>
    </div>
  );
}
