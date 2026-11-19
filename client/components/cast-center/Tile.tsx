import { useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import type { ReceiverInfo } from '../../../server/types.js';
import { volumeUnknown } from '../../lib/cast-volume';
import { receiverState, RECEIVER_STATE_LABEL } from '../../lib/receiver-state';
import { IconPlay, IconPause, IconStop, IconSpeaker, IconTv } from '../Icons';
import { PowerButton } from './PowerButton';
import { VolumeBar } from './VolumeBar';
import type { CmdFn } from './shared';

/** One device in the Cast Center's grid: what it plays, its volume, play or pause and stop. */
export function Tile({ r, idx, dimmed, onCmd, onOpen }: { r: ReceiverInfo; idx: number; dimmed: boolean; onCmd: CmdFn; onOpen: (rect: DOMRect) => void }) {
  const [busy, setBusy] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const m = r.media;
  const st = receiverState(r);
  const Icon = r.audioOnly ? IconSpeaker : IconTv;
  const run = async (c: 'stop' | 'pause' | 'play') => { setBusy(true); try { await onCmd(r.id, c); } finally { setBusy(false); } };
  const openIt = (e: RMouseEvent) => {
    if ((e.target as HTMLElement).closest('button, [role=slider]')) return;
    if (el.current) onOpen(el.current.getBoundingClientRect());
  };
  return (
    <div ref={el} className={`cc-tile${r.app ? ' live' : ''}${r.online ? '' : ' off'}${dimmed ? ' dim' : ''}`} style={{ ['--i' as string]: idx }} onClick={openIt} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && el.current) onOpen(el.current.getBoundingClientRect()); }}>
      <div className="cc-tile-head">
        <span className="cc-ico"><Icon /></span>
        <span className="cc-name">{r.name}<span className={`cc-state ${st}`}><i />{RECEIVER_STATE_LABEL[st]}</span></span>
        <PowerButton r={r} />
      </div>
      <div className="cc-now">
        {m?.artwork ? <img className="cc-art" src={m.artwork} alt="" /> : null}
        <div className="cc-now-text">
          {r.app ? (
            <>
              <strong>{m?.title || r.app.name}</strong>
              <span>{[r.kino ? 'Kino' : m?.title ? r.app.name : null, m?.subtitle].filter(Boolean).join(' · ') || r.model}</span>
            </>
          ) : <span>{r.online ? r.model : r.asleep ? (r.canWake ? 'Off. Turn it on here, or cast to it' : 'Off. Turn it on with the remote once so Kino can wake it') : 'Not reachable right now'}</span>}
        </div>
      </div>
      {volumeUnknown(r) ? null : <VolumeBar r={r} onCmd={onCmd} />}
      <div className="cc-actions">
        <button className="cc-btn" disabled={busy || !m} aria-label={m?.state === 'PLAYING' ? 'Pause' : 'Play'} onClick={() => run(m?.state === 'PLAYING' ? 'pause' : 'play')}>{m?.state === 'PLAYING' ? <IconPause /> : <IconPlay />}</button>
        <button className="cc-btn stop" disabled={busy || !r.app} aria-label="Stop" onClick={() => run('stop')}><IconStop /></button>
      </div>
    </div>
  );
}
