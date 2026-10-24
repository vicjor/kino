import { useEffect, useState } from 'react';
import type { Source, StreamsResponse, Target } from '../../server/types.js';
import { api } from '../lib/api';
import { target as ownTarget } from '../lib/player-caps';
import { Sheet } from './Sheet';
import { SourceList } from './SourceList';
import { IconRefresh } from './Icons';

/**
 * Browse the other releases of what is playing, without stopping it. Picking one
 * swaps the stream and keeps your position. Lives in the side panel over the video.
 */
export function SourcesSheet({ type, videoId, currentId, reason, target, title, hint, onPick, onCast, onDownload, onClose }: {
  type: string; videoId: string; currentId: string; reason?: string;
  /** Rank for this device instead of the browser (a Chromecast controller passes 'chromecast'). */
  target?: Target; title?: string; hint?: string;
  onPick: (s: Source) => void; onCast?: (s: Source) => void; onDownload?: (s: Source) => void; onClose: () => void;
}) {
  const [data, setData] = useState<StreamsResponse | null>(null);
  const [err, setErr] = useState('');
  const load = () => { setData(null); setErr(''); api.streams(type, videoId, target || ownTarget()).then(setData).catch((e) => setErr(e.message)); };
  useEffect(load, [type, videoId]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = data?.sources.find((s) => s.id === currentId);
  const others = data ? { ...data, sources: data.sources.filter((s) => s.id !== currentId) } : null;
  return (
    <Sheet title={title || 'Switch source'} onClose={onClose} side>
      {reason ? <p className="hint srcs-reason">{reason}</p> : null}
      {current ? <div className="srcs-current"><span className="chip accent">Playing now</span> <span>{current.provider || current.addon}{current.resolution && current.resolution !== 'other' ? ` · ${current.resolution}` : ''}{current.sizeBytes ? ` · ${(current.sizeBytes / 1024 ** 3).toFixed(1)} GB` : ''}{current.seeders != null ? ` · ${current.seeders} seeds` : ''}</span></div> : null}
      <p className="hint">{hint || 'Pick another release and playback continues from where you are.'}</p>
      {err ? <div className="err">{err} <button className="btn small" onClick={load}>Retry</button></div> : null}
      {!data && !err ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
      {others ? <SourceList data={others} onPlay={onPick} onCast={onCast} onDownload={onDownload} /> : null}
      <div className="sheet-actions" style={{ justifyContent: 'center' }}><button className="btn ghost small" onClick={load}><IconRefresh /> Reload sources</button></div>
    </Sheet>
  );
}
