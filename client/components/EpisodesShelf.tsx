import { useEffect, useState } from 'react';
import type { Episode, Meta, Progress } from '../../server/types.js';
import { EpisodePicker } from './EpisodePicker';
import { IconX } from './Icons';
import '../styles/title.css';

const OUT_MS = 260;

/**
 * The season's episodes over the bottom of the player, as the TV app shows them: it rises out of the Episodes pill
 * at the foot, the same cards as on the show's page (watched, minutes left, next up), and a tap plays that one,
 * here or on the TV. A tap on the picture above, or Esc, sends it back down.
 */
export function EpisodesShelf({ meta, progress, current, open, onPick, onClose }: {
  meta: Meta; progress: Record<string, Progress>; current?: string; open: boolean; onPick: (e: Episode) => void; onClose: () => void;
}) {
  const [shown, setShown] = useState(open);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (open) { setShown(true); setOut(false); return; }
    if (!shown) return;
    setOut(true);
    const t = window.setTimeout(() => { setShown(false); setOut(false); }, OUT_MS);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [open, onClose]);
  if (!shown || !meta.videos?.length) return null;
  return (
    <>
      <div className={`eps-dim${out ? ' out' : ''}`} onClick={(e) => { e.stopPropagation(); onClose(); }} aria-hidden="true" />
      <div className={`eps-shelf${out ? ' out' : ''}`} role="dialog" aria-label={`${meta.name} episodes`} onClick={(e) => e.stopPropagation()}>
        <div className="eps-head">
          <strong>{meta.name}</strong>
          <button className="pc-circle" aria-label="Close episodes" onClick={onClose}><IconX /></button>
        </div>
        <EpisodePicker videos={meta.videos} progress={progress} selected={current} onSelect={onPick} fallback={meta.background || meta.poster} />
      </div>
    </>
  );
}
