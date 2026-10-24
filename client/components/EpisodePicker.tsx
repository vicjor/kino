import { useMemo, useState, useEffect, useRef, useCallback, useId } from 'react';
import { resumePoint, isFinished, minutesLeft } from '../lib/progress';
import type { Episode, Progress } from '../../server/types.js';
import { fmtDate } from '../lib/format';
import { seasonsOf, sortedEpisodes, isReleased, nextUp } from '../lib/episodes';
import { IconPlay, IconCheck, IconBack, IconCast } from './Icons';
import { onTabKeys } from '../lib/tabs';
import { scrollBehavior } from '../lib/motion';
import { SegThumb } from './SegThumb';
export { sortedEpisodes };   // the Player imports it from here

/** `onPlay`: a tap on the episode already selected plays it. `onCast`: a TV button on each card. */
export function EpisodePicker({ videos, progress, selected, onSelect, onPlay, onCast, onToggleWatched, ratings, fallback }: { videos: Episode[]; progress: Record<string, Progress>; selected?: string; onSelect: (e: Episode) => void; onPlay?: (e: Episode) => void; onCast?: (e: Episode) => void; onToggleWatched?: (e: Episode) => void; ratings?: Record<string, { rating: number; votes: number }>; fallback?: string }) {
  // Stills that failed to load: those cards show the show's backdrop instead of a broken-image glyph.
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const seasons = useMemo(() => seasonsOf(videos), [videos]);
  const next = useMemo(() => nextUp(videos, progress), [videos, progress]);
  const initial = selected ? Number(selected.split(':')[1]) : next?.season ?? seasons[0];
  const [season, setSeason] = useState<number>(initial);
  useEffect(() => { if (selected) setSeason(Number(selected.split(':')[1])); }, [selected]);
  const eps = useMemo(() => sortedEpisodes(videos).filter((v) => v.season === season), [videos, season]);
  const watched = eps.filter((e) => isFinished(progress[e.id])).length;
  const rail = useRef<HTMLUListElement>(null);
  // Arrow buttons for pointer users. Hidden at either end so they never point at nothing.
  const [edges, setEdges] = useState({ prev: false, next: false });
  const measure = useCallback(() => {
    const el = rail.current; if (!el) return;
    setEdges({ prev: el.scrollLeft > 4, next: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => { measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, [measure, eps.length]);
  const page = (dir: 1 | -1) => { const el = rail.current; if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: scrollBehavior() }); };
  // Keep the selected episode in view when the season or selection changes, without yanking the rail around:
  // a card already fully on screen stays put. (Positions come from rects: each card sits in a positioned li,
  // so offsetLeft would be near zero and scroll the rail back to the start.)
  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>('.epc.sel');
    const box = rail.current;
    if (!el || !box) return;
    const b = box.getBoundingClientRect(); const r = el.getBoundingClientRect();
    if (r.left >= b.left && r.right <= b.right) return;
    const left = box.scrollLeft + (r.left - b.left) - (box.clientWidth - r.width) / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: scrollBehavior() });
  }, [selected, season, eps.length]);
  // Seasons are tabs over one panel, the episode rail. Tab reaches the chosen season, the arrows move between them.
  const uid = useId();
  const tabbed = seasons.length > 1;
  const cur = seasons.includes(season) ? season : seasons[0];
  const tabId = (s: number) => `${uid}-season-${s}`;
  const panelId = `${uid}-episodes`;
  const now = Date.now();
  return (
    <div className="episodes">
      <div className="ep-head">
        {tabbed ? (
          <div className="seasons" role="tablist" aria-label="Seasons" onKeyDown={(e) => onTabKeys(e, (i) => setSeason(seasons[i]))}>
            <SegThumb />
            {seasons.map((s) => <button key={s} id={tabId(s)} role="tab" aria-selected={s === season} aria-controls={panelId} tabIndex={s === cur ? 0 : -1} className={`seg${s === season ? ' on' : ''}`} onClick={() => setSeason(s)}>{s === 0 ? 'Specials' : `Season ${s}`}</button>)}
          </div>
        ) : null}
        <div className="ep-count">{eps.length} episode{eps.length === 1 ? '' : 's'}{watched ? ` · ${watched} watched` : ''}</div>
      </div>
      <div className="eprail-wrap" {...(tabbed ? { id: panelId, role: 'tabpanel', 'aria-labelledby': tabId(cur) } : {})}>
        <button className={`rail-arrow prev${edges.prev ? '' : ' off'}`} aria-label="Earlier episodes" tabIndex={edges.prev ? 0 : -1} onClick={() => page(-1)}><IconBack /></button>
        <button className={`rail-arrow next${edges.next ? '' : ' off'}`} aria-label="Later episodes" tabIndex={edges.next ? 0 : -1} onClick={() => page(1)}><IconBack /></button>
      <ul className="eprail" ref={rail} onScroll={measure}>
        {eps.map((e) => {
          const p = progress[e.id];
          const pct = p && p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
          const done = isFinished(p);
          const future = !isReleased(e, now);
          const sel = selected === e.id;
          const left = p && resumePoint(p) != null ? minutesLeft(p) : 0;
          const sub = future ? `Airs ${fmtDate(e.released)}` : left ? `${left} min left` : fmtDate(e.released);
          return (
            <li key={e.id}>
              <button className={`epc${sel ? ' sel' : ''}${future ? ' future' : ''}${done ? ' done' : ''}`} onClick={() => (sel && onPlay ? onPlay(e) : onSelect(e))} aria-current={sel ? 'true' : undefined}>
                <div className="epc-thumb">
                  {e.thumbnail && !broken.has(e.id) ? <img src={e.thumbnail} alt="" loading="lazy" onError={() => setBroken((b) => new Set(b).add(e.id))} />
                    : fallback ? <img className="epc-fallback" src={fallback} alt="" loading="lazy" /> : null}
                  <span className="epc-num">{e.episode}</span>
                  {done && !onToggleWatched ? <span className="epc-done" aria-label="Watched"><IconCheck /></span> : null}
                  {ratings?.[e.id] ? <span className={`epc-rating${ratings[e.id].rating >= 8.5 ? ' hot' : ''}`} title={`IMDb ${ratings[e.id].rating}, ${ratings[e.id].votes.toLocaleString()} votes`}>★ {ratings[e.id].rating.toFixed(1)}</span> : null}
                  {!sel && !done && next?.id === e.id ? <span className="chip accent epc-next">Next up</span> : null}
                  <span className="card-play"><IconPlay /></span>
                  {pct > 0 && !done ? <div className="bar"><i style={{ width: `${pct}%` }} /></div> : null}
                </div>
                <div className="epc-title">{e.title || `Episode ${e.episode}`}</div>
                <div className="epc-sub">{sub}</div>
              </button>
              {onCast && !future ? <button className="epc-mark epc-cast" aria-label="Play on TV" title="Play on TV" onClick={(ev) => { ev.stopPropagation(); onCast(e); }}><IconCast /></button> : null}
              {onToggleWatched && !future ? <button className={`epc-mark${done ? ' on' : ''}`} aria-label={done ? 'Mark as not watched' : 'Mark as watched'} title={done ? 'Mark as not watched' : 'Mark as watched'} onClick={(ev) => { ev.stopPropagation(); onToggleWatched(e); }}><IconCheck /></button> : null}
            </li>
          );
        })}
      </ul>
      </div>
    </div>
  );
}
