import { useEffect, useState } from 'react';
import type { HomeResponse, MetaPreview, Progress, CastStatus, DiscoverRow } from '../../server/types.js';
import { api, cached, urls } from '../lib/api';
import { Row } from '../components/Row';
import { Brand } from '../components/Brand';
import { MetaCard, ProgressCard, DownloadCard, EpisodeStack, UpcomingCard, SkeletonRow, resumeUrl, splitProgressName, minutesLeft } from '../components/Card';
import { useStore, setStore, toast } from '../lib/store';
import { groupNewEpisodes } from '../components/home-data';
import { MoodTiles } from '../components/MoodTiles';
import { browseUrl } from '../components/moods';
import { IconGear, IconLink, IconFilm, IconCast, IconPlay, IconPause, IconStop, IconSubs, IconVol, IconMute, IconPhone, IconX, IconInfo, IconPlus, IconCheck } from '../components/Icons';
import { Featured, type Slide } from '../components/Featured';
import { useContinueCast, continueTarget } from '../components/ContinueCast';
import { navigate, titleUrl } from '../lib/router';
import { handoffHere } from '../lib/cast-actions';
import { isMagnetId, metaIdOf } from '../lib/handoff';
import { fmtTime, episodeCode } from '../lib/format';
import { openCastCenter } from '../lib/overlays';
import { OPEN_CAST_KEYS } from '../components/CastHotkeys';
import { Keycap } from '../components/Hud';
import { isTouch } from '../lib/player-caps';
import { tvVolume, setTvVolume } from '../lib/cast-volume';
import { useLoad } from '../lib/use-load';
import '../styles/home.css';

/**
 * Dismissed spotlights, keyed by item and the moment you last watched it. Watching again brings it back.
 * Per browser on purpose: closing a banner on the phone should not close it on the TV laptop.
 */
const DISMISS_KEY = 'kino.spot.dismissed';
function spotKey(p: Progress): string { return `${p.videoId}:${p.updatedAt}`; }
function readDismissed(): string[] { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); } catch { return []; } }
function dismiss(p: Progress): string[] {
  const next = [spotKey(p), ...readDismissed().filter((k) => k !== spotKey(p))].slice(0, 30);
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

/** The first slide: whatever you were watching last, one tap from resuming. */
function Spotlight({ p, onClose, onCast, castLabel }: { p: Progress; onClose: () => void; onCast?: () => void; castLabel?: string }) {
  const { show, episode } = splitProgressName(p);
  const pct = p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
  const left = minutesLeft(p);
  const label = p.season != null && p.episode != null ? episodeCode(p.season, p.episode) : '';
  return (
    <>
      <div className="spot-fade" />
      <button className="iconbtn spot-close" aria-label="Hide this" title="Hide this" onClick={onClose}><IconX /></button>
      <div className="spot-body">
        <div className="spot-kicker">{p.pos ? 'Continue watching' : 'Up next'}</div>
        <h1 className="spot-title">{show}</h1>
        <div className="spot-sub">{[label, episode, left ? `${left} min left` : p.pos ? '' : 'Next episode'].filter(Boolean).join(' · ')}</div>
        <div className="spot-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
        <div className="spot-actions">
          <button className="btn primary big" onClick={() => navigate(resumeUrl(p))}><IconPlay /> {p.pos ? 'Continue' : 'Play'}</button>
          {onCast ? <button className="btn glass" onClick={onCast}><IconCast /> <span className="lbl">{castLabel}</span></button> : null}
          <button className="btn glass" onClick={() => navigate(titleUrl(p.type, p.metaId, p.videoId))}><IconInfo /> <span className="lbl">Details</span></button>
          {/* Phones: the hide control rides in the button row, clear of the header's buttons above the artwork. */}
          <button className="btn glass round spot-hide" aria-label="Hide this" title="Hide this" onClick={onClose}><IconX /></button>
        </div>
      </div>
    </>
  );
}

/** A featured slide: something the rails think you would like, its year, rating and what it is about. */
function FeaturedTitle({ m, kicker }: { m: MetaPreview; kicker: string }) {
  const [saved, setSaved] = useState(false);
  const rating = m.imdbRating || m.tmdbRating;
  const open = () => navigate(titleUrl(m.type, m.id));
  const save = async () => {
    try { if (saved) await api.removeWatchlist(m.id); else await api.addWatchlist(m.id, { type: m.type, name: m.name, poster: m.poster }); setSaved(!saved); toast(saved ? `${m.name} is off your list` : `${m.name} is on your list`); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <>
      <div className="spot-fade" />
      <div className="spot-body">
        <div className="spot-kicker">{kicker}</div>
        <h2 className="spot-title">{m.name}</h2>
        <div className="spot-sub">{[m.year?.replace(/-$/, ''), m.type === 'series' ? 'Series' : 'Film', rating ? `IMDb ${rating}` : '', m.genres?.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}</div>
        {m.description ? <p className="spot-plot">{m.description}</p> : null}
        <div className="spot-actions">
          <button className="btn primary big" onClick={open}><IconPlay /> Watch</button>
          <button className="btn glass" aria-pressed={saved} onClick={save}>{saved ? <IconCheck /> : <IconPlus />} <span className="lbl">{saved ? 'On your list' : 'Your list'}</span></button>
          <button className="btn glass" onClick={open}><IconInfo /> <span className="lbl">Details</span></button>
        </div>
      </div>
    </>
  );
}

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [q]);
  return m;
}

/**
 * While something is casting, the hero IS the player (desktop). Same surface as the
 * spotlight, so the page does not jump when playback starts; the floating widget
 * and the bottom bar are gone on desktop and this is where they went.
 */
function CastSpot({ cast, item }: { cast: CastStatus; item?: Progress }) {
  const [seek, setSeek] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<unknown>) => { setBusy(true); f().catch((e) => toast((e as Error).message, 'error')).finally(() => setBusy(false)); };
  const receivers = useStore((s) => s.receivers);
  const tv = tvVolume(cast, receivers);
  const playing = cast.state === 'PLAYING';
  const dur = cast.duration || 0;
  const pos = seek ?? cast.currentTime ?? 0;
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const name = item ? splitProgressName(item) : { show: cast.title || 'Casting', episode: '' };
  const label = item?.season != null && item.episode != null ? episodeCode(item.season, item.episode) : '';
  const left = dur ? Math.max(0, Math.round((dur - pos) / 60)) : 0;
  const bg = item?.background || item?.poster || cast.poster;
  const handoff = () => run(() => handoffHere(cast));
  return (
    <section className="spot playing" style={bg ? { ['--art' as string]: `url(${bg})` } : undefined} aria-label="Now playing on the TV"
      onClick={(e) => { if ((e.target as HTMLElement).closest('button, input, a')) return; if (cast.videoId && !isMagnetId(cast.videoId)) navigate(titleUrl(cast.type || 'movie', metaIdOf(cast.videoId), cast.videoId)); }}>
      <div className="spot-fade" />
      <div className="spot-body">
        <div className="spot-kicker live"><i />Now on {cast.deviceName || 'the TV'}{cast.state === 'BUFFERING' ? ' · loading' : ''}</div>
        <h1 className="spot-title">{name.show}</h1>
        {name.episode || label ? <div className="spot-sub">{[label, name.episode, left ? `${left} min left` : ''].filter(Boolean).join(' · ')}</div> : null}
        <div className="spot-scrub" style={{ ['--p' as string]: `${pct}%` }}>
          <span>{fmtTime(pos)}</span>
          <input type="range" min={0} max={dur || 1} step={1} value={pos} disabled={!dur} aria-label="Position"
            onChange={(e) => setSeek(Number(e.target.value))}
            onPointerUp={() => { if (seek != null) { run(() => api.castSeek(seek)); setSeek(null); } }}
            onKeyUp={() => { if (seek != null) { run(() => api.castSeek(seek)); setSeek(null); } }} />
          <span>{dur ? fmtTime(dur) : ''}</span>
        </div>
        <div className="spot-actions">
          <button className="btn primary big" disabled={busy} data-hint={playing ? 'Pause' : 'Play'} data-key="Space" onClick={() => run(() => (playing ? api.castPause() : api.castResume()))}>{playing ? <IconPause /> : <IconPlay />} {playing ? 'Pause' : 'Resume'}</button>
          <button className="btn glass round stop" aria-label="Stop casting" disabled={busy} data-hint="Stop casting" data-key="X" onClick={() => run(() => api.castStop())}><IconStop /></button>
          <button className="btn glass round" aria-label="Subtitles and more" data-hint="Subtitles and more" data-key="S" onClick={openCastCenter}><IconSubs /></button>
          {tv.unknown ? null : <button className="btn glass round" aria-label={tv.muted ? 'Unmute' : 'Mute'} disabled={busy} data-hint={tv.muted ? 'Sound on' : 'Mute'} data-key="M" onClick={() => run(() => setTvVolume(tv, { muted: !tv.muted }))}>{tv.muted ? <IconMute /> : <IconVol />}</button>}
          <button className="btn glass" disabled={busy} data-hint="Play here instead" data-key="H" onClick={handoff}><IconPhone /> Continue on this device</button>
          {item ? <button className="btn glass" onClick={() => navigate(titleUrl(item.type, item.metaId, item.videoId))}>Details</button> : null}
        </div>
        {!isTouch ? (
          <div className="spot-keys">
            {/* The hints are for sighted keyboard users; the button that opens the full list stays reachable */}
            <span aria-hidden="true"><Keycap k="Space" /> Play</span>
            <span aria-hidden="true"><Keycap k="←" /><Keycap k="→" /> 10 s</span>
            <span aria-hidden="true"><Keycap k="↑" /><Keycap k="↓" /> Volume</span>
            {item?.season != null ? <span aria-hidden="true"><Keycap k="N" /> Next</span> : null}
            <button className="spot-keys-all" onClick={() => window.dispatchEvent(new Event(OPEN_CAST_KEYS))}><Keycap k="?" /> All shortcuts</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DiscoverRail({ row }: { row: DiscoverRow }) {
  return <Row title={row.title} sub={row.reason} href={row.href}>{row.items.map((m) => <MetaCard key={m.id} m={m} />)}</Row>;
}

/** Older servers without discover rails: keep the two popular rows. */
function fallbackRows(d: HomeResponse): HomeResponse['discover'] {
  return [{ key: 'popular-movies', title: 'Popular movies', items: d.popularMovies }, { key: 'popular-series', title: 'Popular series', items: d.popularSeries }];
}

export function Home() {
  // Paint the last Home at once; the fetch refreshes it. An error only shows when there is nothing to show.
  const home = useLoad(api.home, { initial: () => cached<HomeResponse>(urls.home()) });
  const { data, error: err, setData } = home;

  const downloads = useStore((s) => s.downloads);
  const cast = useStore((s) => s.cast);
  const desktop = useMedia('(min-width: 720px)');
  const cc = useContinueCast();
  const castOf = (p: Progress) => { const t = continueTarget(p); return t ? () => cc.start(t) : undefined; };
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  // Downloads arrive live over SSE; seed them once so the row is there before the first event.
  useEffect(() => { if (downloads == null) api.downloads().then((d) => setStore({ downloads: d })).catch(() => {}); }, [downloads]);

  // Spotlight = the last thing you watched, and only that. Closing it hides the
  // banner (the item goes back into the rail); nothing else slides into its place.
  // It comes back by itself the next time you watch something.
  const cw = data?.continueWatching ?? [];
  const top = cw.find((p) => p.background || p.poster);
  const first = top && !dismissed.includes(spotKey(top)) ? top : undefined;
  const removeProgress = async (p: Progress) => {
    try {
      await api.removeProgress(p.videoId);
      setData((d) => d && { ...d, continueWatching: d.continueWatching.filter((x) => x.videoId !== p.videoId) });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const stacks = data ? groupNewEpisodes(data.newEpisodes) : [];
  // Intent beats algorithm: what you saved and what you follow, one rail, second from the top.
  const yourList: MetaPreview[] = data ? [...data.watchlist, ...(data.following || []).filter((f) => !data.watchlist.some((w) => w.id === f.id))] : [];
  const rows = data ? (data.discover?.length ? data.discover : fallbackRows(data)) : [];
  // The featured shelf: what you were watching first, then a handful from the top rail that have artwork.
  const pick = rows.find((r) => r.items.some((m) => m.background));
  const slides: Slide[] = [
    ...(first ? [{ key: `continue:${first.videoId}`, art: first.background || first.poster, label: splitProgressName(first).show, body: <Spotlight p={first} onClose={() => setDismissed(dismiss(first))} onCast={castOf(first)} castLabel={cc.label} /> }] : []),
    ...(pick ? pick.items.filter((m) => m.background && m.id !== first?.metaId && !m.watched).slice(0, 5).map((m) => ({ key: m.id, art: m.background, label: m.name, body: <FeaturedTitle m={m} kicker={pick.title} /> })) : []),
  ];
  return (
    <div className="home">
      <header className="screen-head home-head">
        <a className="wordmark big" href="#/" aria-label="Kino home"><Brand /></a>
        {/* Search and the TVs sit by the tab bar; Settings lives here, top right, as on an iPhone. */}
        <button className="iconbtn ghost-btn" aria-label="Settings" onClick={() => navigate('/settings')}><IconGear /></button>
      </header>
      {err && !data ? <div className="err">{err} <button className="btn small" onClick={() => home.reload()}>Try again</button></div> : null}
      {data ? (
        <>
          {cast.active && desktop ? <CastSpot cast={cast} item={cw.find((p) => p.videoId === cast.videoId)} /> : <Featured slides={slides} />}
          {/* Up Next: what you are in the middle of, then the new episodes of what you follow. One place to start. */}
          <Row title="Up Next" wide>{[
            ...cw.map((p) => <ProgressCard key={p.videoId} p={p} onRemove={() => removeProgress(p)} onCast={castOf(p)} castLabel={cc.label} />),
            ...stacks.map((g) => <EpisodeStack key={g.show.id} show={g.show} episodes={g.episodes} />),
          ]}</Row>
          {cc.sheet}
          <Row title="Your list" more={<a href="#/library">Library</a>} empty="Save a title or follow a show and it lands here.">{yourList.map((m) => <MetaCard key={m.id} m={m} />)}</Row>
          {downloads?.length ? <Row title="Downloads" wide>{downloads.map((d) => <DownloadCard key={d.key} d={d} />)}</Row> : null}
          {data.upcoming?.length ? <Row title="Coming up" sub="Next episodes of the shows you watch" wide>{data.upcoming.map((u) => <UpcomingCard key={u.episode.id} u={u} />)}</Row> : null}
          {rows.slice(0, 3).map((row) => <DiscoverRail key={row.key} row={row} />)}
          <Row title="In the mood for" sub="Pick a feeling, get a shelf" href={`#${browseUrl('all')}`} wide><MoodTiles limit={6} /></Row>
          {rows.slice(3).map((row) => <DiscoverRail key={row.key} row={row} />)}
          <div className="home-foot">
            <button className="btn ghost" onClick={() => navigate(browseUrl('all'))}><IconFilm /> Browse everything</button>
            <button className="btn ghost" onClick={() => navigate('/magnet')}><IconLink /> Play a magnet link</button>
          </div>
        </>
      ) : !err ? <div aria-busy="true" aria-label="Loading"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div> : null}
    </div>
  );
}
