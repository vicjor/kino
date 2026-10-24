import { useEffect, useRef, useState } from 'react';
import type { ReceiverInfo } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore } from '../lib/store';
import { tvsOnly } from '../lib/tvs';
import { thisDeviceName } from '../lib/devices';
import { isTouch } from '../lib/player-caps';
import type { Tv } from '../lib/cast-actions';
import { toggleLockRemote, lockRemoteSupported } from './LockRemote';
import { IconCast, IconTv, IconPhone, IconLaptop, IconCheck, IconAirplay, IconLock } from './Icons';

const HERE = thisDeviceName(navigator.userAgent, navigator.maxTouchPoints);
const OUT_MS = 180;
const pickable = (r: ReceiverInfo) => r.online || (!!r.asleep && !!r.canWake);

/** One line on what a TV is doing, so you know before you send the film there. */
function tvLine(r: ReceiverInfo, current: boolean): string {
  if (current) return r.media?.state === 'PAUSED' ? 'Paused here' : 'Playing now';
  if (r.waking) return 'Turning on…';
  if (r.asleep) return r.canWake ? 'Off · Kino turns it on' : 'Off · turn it on with its remote';
  if (!r.online) return 'Not reachable';
  if (r.kino) return 'Playing from Kino';
  if (r.media?.state === 'PLAYING') return `Playing ${r.media.title || r.app?.name || ''}`.trim();
  if (r.app) return `${r.app.name} open`;
  return 'Ready';
}

/**
 * Where it plays, as AirPlay does it on iOS: one button in the player's corner and a list that grows out of it. This
 * screen first, then every TV with what it is doing, then Safari's own AirPlay picker. Picking a TV sends the film
 * there and the player stays as its remote; picking this screen takes it back from where the TV is. On the TV, a phone
 * can also put the remote on its lock screen from here.
 */
export function PlayOn({ open, onOpen, onClose, deviceId, busy, pulse, onTv, onHere, onAirplay }: {
  open: boolean; onOpen: () => void; onClose: () => void;
  /** The TV it plays on now; null while it plays on this screen. */
  deviceId: string | null;
  /** The TV (or 'here') a switch is under way to. */
  busy?: string | null;
  pulse?: boolean;
  onTv: (tv: Tv) => void; onHere?: () => void; onAirplay?: () => void;
}) {
  const receivers = useStore((s) => s.receivers);
  const lockOn = useStore((s) => !!deviceId && s.lockRemote === deviceId);
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(open);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (open) { setShown(true); setOut(false); return; }
    if (!shown) return;
    setOut(true);
    const t = window.setTimeout(() => { setShown(false); setOut(false); }, OUT_MS);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // A fresh look at the network each time it opens: a TV switched on a minute ago belongs in the list.
  useEffect(() => { if (open) api.castReceivers(true).then((r) => setStore({ receivers: r })).catch(() => undefined); }, [open]);
  // A tap outside puts it away and does nothing else (no pause behind it); Esc does too, before the player sees it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      onClose();
      const eat = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 450);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); };
  }, [open, onClose]);

  const tvs = tvsOnly(receivers).sort((a, b) => Number(b.id === deviceId) - Number(a.id === deviceId) || Number(pickable(b)) - Number(pickable(a)) || a.name.localeCompare(b.name));
  const current = deviceId ? (receivers || []).find((r) => r.id === deviceId) : undefined;
  const routedName = current?.name || 'TV';
  const HereIcon = isTouch ? IconPhone : IconLaptop;
  return (
    <div className="playon" ref={root}>
      <button className={`playon-btn${deviceId ? ' routed' : ''}${pulse ? ' cast-pulse' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={deviceId ? `Playing on ${routedName}. Change where it plays` : 'Play on a TV'} data-hint="Play on" data-key="T"
        onClick={() => (open ? onClose() : onOpen())}>
        {deviceId ? <><IconTv /><span className="playon-name">{routedName}</span></> : <IconCast />}
      </button>
      {shown ? (
        <div className={`playon-menu${out ? ' out' : ''}`} role="menu" aria-label="Play on">
          <div className="playon-head">Play on</div>
          <button role="menuitemradio" aria-checked={!deviceId} className={`playon-row${!deviceId ? ' on' : ''}`} disabled={!deviceId ? false : !onHere || !!busy}
            onClick={() => (deviceId ? onHere?.() : onClose())}>
            <span className="playon-ico"><HereIcon /></span>
            <span className="playon-text"><strong>{HERE}</strong><small>{deviceId ? 'Carry on here, from where the TV is' : 'Playing now'}</small></span>
            {busy === 'here' ? <span className="spinner sm" /> : !deviceId ? <IconCheck /> : null}
          </button>
          {!receivers ? <div className="playon-row skeleton" aria-hidden="true" /> : null}
          {tvs.map((r) => {
            const on = r.id === deviceId;
            return (
              <button key={r.id} role="menuitemradio" aria-checked={on} className={`playon-row${on ? ' on' : ''}`} disabled={(!on && !pickable(r)) || !!busy}
                onClick={() => (on ? onClose() : onTv({ id: r.id, name: r.name }))}>
                <span className="playon-ico"><IconTv /></span>
                <span className="playon-text"><strong>{r.name}</strong><small>{tvLine(r, on)}</small></span>
                {busy === r.id ? <span className="spinner sm" /> : on ? <IconCheck /> : null}
              </button>
            );
          })}
          {receivers && !tvs.length ? <p className="playon-empty">No TVs on this network yet. Turn one on and it shows up here.</p> : null}
          {onAirplay ? (
            <button role="menuitem" className="playon-row" onClick={() => { onClose(); onAirplay(); }}>
              <span className="playon-ico"><IconAirplay /></span>
              <span className="playon-text"><strong>AirPlay</strong><small>Apple TV and AirPlay TVs</small></span>
            </button>
          ) : null}
          {deviceId && isTouch && lockRemoteSupported ? (
            <button role="menuitemcheckbox" aria-checked={lockOn} className={`playon-row toggle${lockOn ? ' on' : ''}`} onClick={() => toggleLockRemote(deviceId)}>
              <span className="playon-ico"><IconLock /></span>
              <span className="playon-text"><strong>Remote on lock screen</strong><small>{lockOn ? 'On. Pauses other audio on this phone' : 'Steer the TV without unlocking'}</small></span>
              <span className={`playon-switch${lockOn ? ' on' : ''}`} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
