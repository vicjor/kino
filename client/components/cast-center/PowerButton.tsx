import { useState, type MouseEvent as RMouseEvent } from 'react';
import type { ReceiverInfo } from '../../../server/types.js';
import { api } from '../../lib/api';
import { setStore, toast } from '../../lib/store';
import { IconPower } from '../Icons';

/**
 * The TV's power button, playing or not: on over Wake-on-LAN (it keeps waking in the background, the state says so),
 * off over an LG TV's own remote protocol. The first time, the TV asks to allow Kino: a slow answer says so.
 */
export function PowerButton({ r }: { r: ReceiverInfo }) {
  const [busy, setBusy] = useState(false);
  const turnOn = !r.online && !!r.canWake;
  const turnOff = r.online && !!r.canPowerOff;
  if (!turnOn && !turnOff) return null;
  const press = async (e: RMouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    const hint = turnOff ? window.setTimeout(() => toast(`Press Allow on ${r.name} to let Kino turn it off`, 'info', 8000), 2500) : 0;
    try {
      const info = await api.castPower(r.id, turnOn);
      if (info) setStore((s) => ({ receivers: (s.receivers || []).map((x) => (x.id === info.id ? info : x)) }));
      else void api.castReceivers().then((list) => setStore({ receivers: list })).catch(() => undefined);
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { window.clearTimeout(hint); setBusy(false); }
  };
  const label = turnOff ? `Turn ${r.name} off` : `Turn ${r.name} on`;
  return <button className={`cc-power${turnOff ? ' on' : ''}${r.waking ? ' waking' : ''}`} aria-label={label} title={label} disabled={busy || !!r.waking} onClick={press}><IconPower /></button>;
}
