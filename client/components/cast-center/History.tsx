import { useEffect, useState } from 'react';
import type { ReceiverInfo, CastHistoryEntry } from '../../../server/types.js';
import { api } from '../../lib/api';
import { relTime } from '../../lib/format';
import { IconPlay } from '../Icons';

/** "Recently played here" for one device; Kino's own entries play again with one tap. */
export function History({ r, busy, onReplay }: { r: ReceiverInfo; busy: boolean; onReplay: (k: NonNullable<CastHistoryEntry['kino']>) => void }) {
  const [history, setHistory] = useState<CastHistoryEntry[] | null>(null);
  useEffect(() => { api.castHistory(r.id).then(setHistory).catch(() => setHistory([])); }, [r.id, r.media?.title]);
  return (
    <div className="cc-hist">
      <h3>Recently played here</h3>
      {history === null ? <div className="cc-hist-empty">…</div> : null}
      {history && !history.length ? <div className="cc-hist-empty">Nothing yet. Kino remembers what plays on this device from now on.</div> : null}
      {(history || []).slice(0, 12).map((h, i) => (
        <div key={h.ts + ':' + i} className="cc-hist-row">
          {h.artwork || h.kino?.poster ? <img src={h.kino?.poster || h.artwork} alt="" /> : <span className="cc-hist-dot" />}
          <div className="cc-hist-text"><strong>{h.kino?.title || h.title}</strong><span>{[h.app, h.subtitle, relTime(h.ts)].filter(Boolean).join(' · ')}</span></div>
          {h.kino ? <button className="cc-mini" disabled={busy} aria-label="Play again here" onClick={() => onReplay(h.kino!)}><IconPlay /></button> : null}
        </div>
      ))}
    </div>
  );
}
