import { useEffect, useState } from 'react';
import type { UpNext } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore, toast } from '../lib/store';
import { IconTv } from './Icons';
import '../styles/upnext.css';

const OUT_MS = 260;

/**
 * The credits are rolling on the TV: bottom-right card with the next episode and, when auto-next is on,
 * the seconds until it starts. The server owns the state (every phone sees the same countdown and the
 * Chromecast draws it too); this only renders it and sends "play now" or "not now".
 */
export function CastUpNext() {
  const up = useStore((s) => s.cast.upNext);
  const device = useStore((s) => s.cast.deviceName);
  const delay = useStore((s) => s.settings?.autoNextDelaySec || 15);
  const [shown, setShown] = useState<UpNext | null>(null);   // kept through the exit animation
  const [out, setOut] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (up) { setShown(up); setOut(false); return; }
    if (!shown) return;
    setOut(true);
    const t = setTimeout(() => { setShown(null); setOut(false); }, OUT_MS);
    return () => clearTimeout(t);
  }, [up]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shown?.startsAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [shown?.startsAt]);
  if (!shown) return null;

  const e = shown.episode;
  const left = shown.startsAt ? Math.max(0, Math.ceil((shown.startsAt - now) / 1000)) : null;
  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } catch (err) { toast((err as Error).message, 'error', 5000); } finally { setBusy(false); } };
  const playNow = () => act(async () => { setStore({ cast: await api.castNext() }); });
  const notNow = () => act(async () => { setStore({ cast: await api.castUpNext(true) }); });
  const art = e.thumbnail || shown.poster;
  return (
    <div className={`upnext${out ? ' out' : ''}`} role="dialog" aria-live="polite" aria-label="Up next">
      {art ? <img className="upnext-art" src={art} alt="" /> : null}
      <div className="upnext-text">
        <span className="upnext-label"><IconTv />Up next{device ? ` on ${device}` : ''}</span>
        <span className="upnext-title">S{e.season} E{e.episode}{e.title ? ` · ${e.title}` : ''}</span>
        <span className="upnext-show">{shown.show}</span>
        <div className="upnext-actions">
          <button className="btn primary small" disabled={busy} onClick={playNow}>{left != null ? `Play now · ${left}` : 'Play now'}</button>
          <button className="btn ghost small" disabled={busy} onClick={notNow}>Not now</button>
        </div>
      </div>
      {left != null ? <i className="upnext-bar" style={{ width: `${Math.max(0, Math.min(100, (1 - left / Math.max(1, delay)) * 100))}%` }} aria-hidden="true" /> : null}
    </div>
  );
}
