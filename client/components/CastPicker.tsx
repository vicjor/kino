import { useEffect, useState } from 'react';
import type { CastDevice, ReceiverInfo } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore } from '../lib/store';
import { Sheet } from './Sheet';
import { IconTv, IconSpeaker, IconRefresh, IconCast } from './Icons';
import '../styles/castpicker.css';

// A TV Kino has seen before shows even when it is off, so you know whether Kino can turn it on.
const sleepState = (r: ReceiverInfo) => r.waking ? 'Turning on…' : r.canWake ? 'Off · Kino turns it on' : 'Off · turn it on with the remote';
const pickable = (r: ReceiverInfo) => r.online || (!!r.asleep && !!r.canWake);
const stateOf = (r: ReceiverInfo) => r.asleep ? sleepState(r) : !r.online ? 'Offline' : r.kino ? 'Casting from Kino' : r.media?.state === 'PLAYING' ? `Playing · ${r.media.title || r.app?.name || ''}` : r.media?.state === 'PAUSED' ? `Paused · ${r.media.title || r.app?.name || ''}` : r.app ? `${r.app.name} open` : 'Ready';
export const toDevice = (r: ReceiverInfo): CastDevice => ({ id: r.id, name: r.name, model: r.model, audioOnly: r.audioOnly, host: '', port: 8009, kind: r.kind });

/**
 * "Cast to" over the player. Same live receiver list as the Cast Center, so you
 * can see what each device is doing before you send the film there.
 */
export function CastPicker({ onPick, onClose, busy }: { onPick: (d: CastDevice) => void; onClose: () => void; busy?: boolean }) {
  const receivers = useStore((s) => s.receivers);
  const [showAudio, setShowAudio] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [err, setErr] = useState('');
  const refresh = () => { setSpinning(true); setErr(''); api.castReceivers(true).then((r) => setStore({ receivers: r })).catch((e) => setErr(e.message)).finally(() => setTimeout(() => setSpinning(false), 600)); };
  useEffect(() => { if (!receivers) refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!busy) setPicked(null); }, [busy]);

  const all = receivers || [];
  const list = all.filter((r) => showAudio || !r.audioOnly).sort((a, b) => Number(b.online) - Number(a.online) || Number(a.audioOnly) - Number(b.audioOnly) || a.name.localeCompare(b.name));
  const speakers = all.filter((r) => r.audioOnly).length;
  const pick = (r: ReceiverInfo) => { if (busy || !pickable(r)) return; setPicked(r.id); onPick(toDevice(r)); };

  return (
    <Sheet title="Cast to" onClose={onClose} side>
      {err ? <div className="err">{err}</div> : null}
      {!receivers ? <div className="cp-list">{[0, 1].map((i) => <div key={i} className="cp-row skeleton" />)}</div> : null}
      {receivers && !list.length ? (
        <div className="cp-empty">
          <IconCast />
          <strong>{speakers ? 'Only speakers nearby' : 'No TVs or speakers found'}</strong>
          <span>{speakers ? 'Turn on the TV, or show speakers below to send audio there.' : 'Turn on the TV or Chromecast and make sure it is on this Wi‑Fi.'}</span>
        </div>
      ) : null}
      {receivers ? (
        <div className="cp-list" role="listbox" aria-label="TVs and speakers">
          {list.map((r) => {
            const Icon = r.audioOnly ? IconSpeaker : IconTv;
            const live = r.online && !!r.app;
            const isPicked = picked === r.id;
            return (
              <button key={r.id} role="option" aria-selected={isPicked} className={`cp-row${live ? ' live' : ''}${pickable(r) ? '' : ' off'}${r.asleep ? ' asleep' : ''}${isPicked ? ' picked' : ''}`} disabled={busy || !pickable(r)} onClick={() => pick(r)}>
                <span className="cp-ico"><Icon /></span>
                <span className="cp-text">
                  <span className="cp-name">{r.name}</span>
                  <span className={`cp-state${r.online ? (live ? ' live' : ' ready') : r.waking ? ' waking' : ''}`}><i />{stateOf(r)}</span>
                </span>
                {isPicked ? <span className="cp-spin" /> : <span className="cp-go">{r.asleep ? (r.canWake ? 'Turn on' : '') : r.kino ? 'Move here' : live ? 'Take over' : 'Cast'}</span>}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="cp-foot">
        <label className="cp-toggle"><input type="checkbox" checked={showAudio} onChange={(e) => setShowAudio(e.target.checked)} /><span>Show speakers{speakers ? ` (${speakers})` : ''}</span></label>
        <button className={`cp-refresh${spinning ? ' spin' : ''}`} onClick={refresh} aria-label="Rescan"><IconRefresh /></button>
      </div>
    </Sheet>
  );
}
