import { useState } from 'react';
import type { Episode } from '../../server/types.js';
import type { MetaPreview, Progress, DownloadInfo, Upcoming } from '../../server/types.js';
import { navigate, titleUrl, playUrl } from '../lib/router';
import { zoomFrom } from '../lib/zoom';
import { fmtSpeed, fmtBytes, episodeCode } from '../lib/format';
import { minutesLeft } from '../lib/progress';
import { api } from '../lib/api';
import { setStore, toast } from '../lib/store';
import { IconPlay, IconX, IconCast } from './Icons';
import { splitShowName, airLabel } from './home-data';
import '../styles/cards.css';

/**
 * A wide card's artwork with whatever sits on it (tag, play glyph, progress bar). Artwork that fails to
 * load shows the name instead of the broken-image glyph; a new src gets a fresh try.
 */
export function WidePoster({ src, name, children }: { src?: string; name: string; children?: React.ReactNode }) {
  const [broken, setBroken] = useState('');
  return (
    <div className="poster">
      {src && src !== broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(src)} /> : <div className="fallback">{name}</div>}
      <span className="poster-shine" aria-hidden="true" />
      {children}
    </div>
  );
}

/** MetaCard's poster: the same box with nothing on top, 2:3 because the card is not `.wide`. */
function Poster({ src, name }: { src?: string; name: string }) {
  return <WidePoster src={src} name={name} />;
}

/** Where "continue" should go: straight into the player when we remember the source, else the title page. */
export function resumeUrl(p: Progress): string {
  if (p.infoHash != null && p.fileIdx != null) {
    return playUrl({ type: p.type, videoId: p.videoId, metaId: p.metaId, infoHash: p.infoHash, fileIdx: p.fileIdx, name: p.name, poster: p.poster, background: p.background, season: p.season, episode: p.episode });
  }
  return titleUrl(p.type, p.metaId, p.videoId);
}

export function splitProgressName(p: Progress): { show: string; episode: string } {
  return p.season == null ? { show: p.name, episode: '' } : splitShowName(p.name);
}

export { minutesLeft };   // Home imports it from here

export function MetaCard({ m }: { m: MetaPreview }) {
  const rating = m.imdbRating || m.tmdbRating;
  return (
    <button className={`card${m.watched ? ' watched' : ''}`} onClick={(e) => { zoomFrom(e.currentTarget.querySelector('.poster img'), m.poster, m.background); navigate(titleUrl(m.type, m.id), false, 'none'); }}>
      <Poster src={m.poster} name={m.name} />
      {m.watched ? <span className="chip strong tag card-seen" title="In your history">Watched</span> : null}
      <div className="name">{m.name}</div>
      {m.year || rating ? <div className="sub">{[m.year?.replace(/-$/, ''), rating].filter(Boolean).join(' · ')}</div> : null}
    </button>
  );
}

/** Placeholder cards in the shape of MetaCard, shown while the first page loads. */
export function SkeletonCards({ n = 12 }: { n?: number }) {
  return <>{Array.from({ length: n }, (_, i) => (
    <div key={i} className="card skel-card" aria-hidden="true"><div className="poster skel" /><div className="skel skel-line" /><div className="skel skel-line short" /></div>
  ))}</>;
}

/** A rail of placeholders with a title bar, for Home before its first answer. */
export function SkeletonRow() {
  return (
    <section className="section" aria-hidden="true">
      <div className="section-head"><div className="skel skel-title" /></div>
      <div className="rail skel-rail"><SkeletonCards n={8} /></div>
    </section>
  );
}

/** A card with a small remove button in the corner. Cards are buttons, so the remove control is a sibling. */
function Removable({ children, label, onRemove, extra }: { children: React.ReactNode; label: string; onRemove?: () => void; extra?: React.ReactNode }) {
  if (!onRemove && !extra) return <>{children}</>;
  return (
    <div className="rm-card">
      {children}
      {onRemove ? <button className="iconbtn rm-btn" aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onRemove(); }}><IconX /></button> : null}
      {extra}
    </div>
  );
}

export function ProgressCard({ p, onRemove, onCast, castLabel }: { p: Progress; onRemove?: () => void; onCast?: () => void; castLabel?: string }) {
  const pct = p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
  const label = p.season != null && p.episode != null ? episodeCode(p.season, p.episode) : '';
  const { show, episode } = splitProgressName(p);
  const left = minutesLeft(p);
  return (
    <Removable label="Remove from Continue watching" onRemove={onRemove}
      extra={onCast ? <button className="iconbtn card-cast" aria-label={castLabel || 'Continue on TV'} title={castLabel || 'Continue on TV'} onClick={(e) => { e.stopPropagation(); onCast(); }}><IconCast /></button> : null}>
      <button className="card wide" onClick={() => navigate(resumeUrl(p))}>
        <WidePoster src={p.background || p.poster} name={p.name}>
          {label ? <span className="chip strong tag">{label}</span> : null}
          <span className="card-play"><IconPlay /></span>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        </WidePoster>
        <div className="name">{show}</div>
        <div className="sub">{[episode, left ? `${left} min left` : p.pos ? '' : 'Next episode'].filter(Boolean).join(' · ')}</div>
      </button>
    </Removable>
  );
}

/**
 * Several new episodes of one show, stacked like iOS widgets: the newest in front, the rest peeking behind.
 * Hover (or the count badge on touch) fans them out sideways.
 */
export function EpisodeStack({ show, episodes }: { show: MetaPreview; episodes: Episode[] }) {
  const [open, setOpen] = useState(false);
  const n = episodes.length;
  return (
    <div className={`stack${open ? ' open' : ''}`} style={{ '--n': n } as React.CSSProperties} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {episodes.map((e, i) => (
        <button key={e.id} className="card wide stack-item" style={{ '--i': i } as React.CSSProperties} onClick={() => navigate(titleUrl('series', show.id, e.id))} tabIndex={open || i === 0 ? 0 : -1} aria-hidden={!open && i > 0}>
          <WidePoster src={e.thumbnail || show.background} name={show.name}>
            <span className="chip strong tag">{episodeCode(e.season, e.episode)}</span>
            <span className="card-play"><IconPlay /></span>
          </WidePoster>
          <div className="name">{show.name}</div>
          <div className="sub">{e.title || `Episode ${e.episode}`}</div>
        </button>
      ))}
      {n > 1 ? <button className="stack-badge" aria-expanded={open} aria-label={`${n} new episodes, ${open ? 'collapse' : 'show all'}`} onClick={(ev) => { ev.stopPropagation(); setOpen((o) => !o); }}>{n} new</button> : null}
    </div>
  );
}

/**
 * The next episode of a show on its way: the day it airs, big, over the show's backdrop.
 * Tap opens the show, which lands on the episode you can watch now.
 */
export function UpcomingCard({ u }: { u: Upcoming }) {
  const art = u.show.background || u.episode.thumbnail || u.show.poster;
  const when = airLabel(u.episode.released);
  return (
    <button className="card wide upcoming" onClick={() => navigate(titleUrl('series', u.show.id))} aria-label={`${u.show.name}, season ${u.episode.season} episode ${u.episode.episode}, ${when}`}>
      <WidePoster src={art} name={u.show.name}>
        <span className="chip strong tag">{episodeCode(u.episode.season, u.episode.episode)}</span>
        <span className="up-when">{when}</span>
      </WidePoster>
      <div className="name">{u.show.name}</div>
      <div className="sub">{[u.episode.title && !/^Episode \d+$/i.test(u.episode.title) ? u.episode.title : '', u.more ? `then ${u.more} more` : ''].filter(Boolean).join(' · ') || 'New episode'}</div>
    </button>
  );
}

/** A file being fetched for later. Done ones play straight from disk, running ones open the title page. */
export function DownloadCard({ d }: { d: DownloadInfo }) {
  const { show, episode } = splitShowName(d.name);
  const pct = Math.round((d.done ? 1 : d.progress) * 100);
  const go = () => {
    if (d.done) navigate(playUrl({ type: d.type, videoId: d.videoId || d.key, metaId: d.metaId || d.videoId || d.key, infoHash: d.infoHash, fileIdx: d.fileIdx, name: d.name, poster: d.poster, background: d.background }));
    else if (d.metaId) navigate(titleUrl(d.type, d.metaId, d.videoId));
  };
  const remove = async () => {
    try { setStore({ downloads: await api.removeDownload(d.key) }); } catch (err) { toast((err as Error).message, 'error'); }
  };
  const status = d.error ? d.error : d.done ? fmtBytes(d.sizeBytes) : d.active ? `${pct}% · ${fmtSpeed(d.speed)}` : `${pct}% · paused`;
  return (
    <Removable label="Remove download" onRemove={remove}>
      <button className="card wide" onClick={go}>
        <WidePoster src={d.background || d.poster} name={d.name}>
          {d.done ? <span className="chip ok tag">Ready to watch</span> : d.error ? <span className="chip warn tag">Failed</span> : <span className="chip strong tag">Downloading</span>}
          {d.done ? <span className="card-play"><IconPlay /></span> : null}
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        </WidePoster>
        <div className="name">{show}</div>
        <div className="sub">{[episode, status].filter(Boolean).join(' · ')}</div>
      </button>
    </Removable>
  );
}
