import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Meta, MetaPreview, Progress, StreamsResponse, Source, Episode, CastDevice, Ratings } from '../../server/types.js';
import { episodeName } from '../../server/episode-name.js';
import { api, cached, urls, type MetaResponse } from '../lib/api';
import { resumePoint, isFinished, minutesLeft } from '../lib/progress';
import { useRoute, navigate, playUrl } from '../lib/router';
import { target } from '../lib/player-caps';
import { toast, useStore, setStore } from '../lib/store';
import { sendToTv, useSingleTv, resumeNow, type Tv } from '../lib/cast-actions';
import { fmtDate } from '../lib/format';
import { scrollBehavior } from '../lib/motion';
import { TopBar } from '../components/TopBar';
import { SourceList } from '../components/SourceList';
import { EpisodePicker } from '../components/EpisodePicker';
import { nextUp, caughtUp, isReleased, sortedEpisodes, episodeSource } from '../lib/episodes';
import { airLabel } from '../components/home-data';
import { Row } from '../components/Row';
import { MetaCard } from '../components/Card';
import { CastPicker } from '../components/CastPicker';
import { Sheet } from '../components/Sheet';
import { IconHeart, IconBell, IconCheck, IconRefresh, IconPlay, IconDownload, IconCast, IconFilm } from '../components/Icons';
import '../styles/title.css';

export function Title() {
  const route = useRoute();
  const [, type, id] = route.parts;
  const preselect = route.query.get('v') || undefined;
  // A title you have opened before paints from the last answer at once; the fetch below refreshes it.
  const seen = cached<MetaResponse>(urls.meta(type, id));
  const [meta, setMeta] = useState<Meta | null>(seen?.meta ?? null);
  const [progress, setProgress] = useState<Record<string, Progress>>(seen?.progress ?? {});
  const [plotOpen, setPlotOpen] = useState(false);   // the plot shows three lines until tapped
  const [inWatchlist, setInWatchlist] = useState(seen?.inWatchlist ?? false);
  const [following, setFollowing] = useState(seen?.following ?? false);
  const [err, setErr] = useState('');
  const [videoId, setVideoId] = useState<string | undefined>(type === 'movie' ? id : preselect || (seen && type === 'series' && seen.meta.videos?.length ? nextUp(seen.meta.videos, seen.progress)?.id : undefined));
  const [streams, setStreams] = useState<StreamsResponse | null>(null);
  const online = useStore((s) => s.online);
  const [ratings, setRatings] = useState<Ratings | null>(null);
  const [trailer, setTrailer] = useState(false);
  const [streamsErr, setStreamsErr] = useState('');
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [castSrc, setCastSrc] = useState<Source | null>(null);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [similar, setSimilar] = useState<{ title: string; reason?: string; genre?: string; items: MetaPreview[] } | null>(null);
  useEffect(() => { setSimilar(null); api.similar(type, id).then(setSimilar).catch(() => undefined); }, [type, id]);
  // The backdrop lights the page behind it (Ambient.tsx).
  useEffect(() => { setStore({ ambient: meta?.background || meta?.poster || null }); }, [meta?.background, meta?.poster]);
  // Mark an episode watched (or not) without playing it: a one-second "film" that counts as done.
  const toggleWatched = async (e: Episode) => {
    const p = progress[e.id];
    try {
      if (isFinished(p)) { await api.removeProgress(e.id); setProgress((m) => { const n = { ...m }; delete n[e.id]; return n; }); }
      else { const saved = await api.putProgress({ videoId: e.id, metaId: id, type: 'series', pos: 1, dur: 1, name: episodeName(meta?.name, e.season, e.episode, e.title), poster: meta?.poster, season: e.season, episode: e.episode }); setProgress((m) => ({ ...m, [e.id]: saved })); }
    } catch (err) { toast((err as Error).message, 'error'); }
  };

  useEffect(() => { setRatings(null); api.ratings(type, id).then(setRatings).catch(() => undefined); }, [type, id]);
  const loadMeta = useCallback(() => {
    setErr('');
    api.meta(type, id).then((r) => {
      setMeta(r.meta); setProgress(r.progress); setInWatchlist(r.inWatchlist); setFollowing(r.following);
      if (type === 'series' && !preselect && r.meta.videos?.length) {
        const n = nextUp(r.meta.videos, r.progress);
        if (n) setVideoId(n.id);
      }
    }).catch((e) => { if (cached(urls.meta(type, id))) toast((e as Error).message, 'error'); else setErr((e as Error).message); });
  }, [type, id, preselect]);
  useEffect(loadMeta, [loadMeta]);
  // Back from the lock screen or the TV: what played meanwhile moved the resume points, so the buttons say Continue again.
  useEffect(() => {
    const f = () => { if (!document.hidden) api.meta(type, id).then((r) => setProgress(r.progress)).catch(() => undefined); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [type, id]);

  const loadStreams = useCallback(() => {
    if (!videoId) return;
    // Sources you saw a moment ago stay on screen while the addons are asked again.
    setStreams(cached<StreamsResponse>(urls.streams(type, videoId, target())) ?? null); setStreamsErr(''); setLoadingStreams(true);
    api.streams(type, videoId, target()).then(setStreams).catch((e) => setStreamsErr(e.message)).finally(() => setLoadingStreams(false));
  }, [type, videoId]);
  useEffect(loadStreams, [loadStreams]);
  // Back online (the phone woke up, Kino restarted): fetch again instead of leaving an error on screen.
  useEffect(() => { if (online && (err || streamsErr)) { if (err) loadMeta(); if (streamsErr) loadStreams(); } }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const episode: Episode | undefined = useMemo(() => meta?.videos?.find((v) => v.id === videoId), [meta, videoId]);
  const displayName = episode ? episodeName(meta?.name, episode.season, episode.episode, episode.title) : meta?.name || '';
  const cur = videoId ? progress[videoId] : undefined;
  const resumable = resumePoint(cur) != null;
  const left = resumable && cur ? minutesLeft(cur) : 0;
  const epLabel = episode ? `S${episode.season} E${episode.episode}` : '';

  const play = (s: Source) => {
    if (!meta || !videoId) return;
    try { sessionStorage.setItem('kino.binge', s.bingeGroup || ''); } catch { /* ignore */ }
    navigate(playUrl({ type, videoId, metaId: id, infoHash: s.infoHash, fileIdx: s.fileIdx, name: displayName, poster: meta.poster, background: episode?.thumbnail || meta.background, season: episode?.season, episode: episode?.episode }));
  };
  const scrollToSources = () => document.getElementById('sources')?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  const scrollToEpisodes = () => document.getElementById('episodes')?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  /**
   * The one button you should not have to hunt for. Resumes with the remembered source, otherwise plays the
   * best pick, otherwise takes you to the source list.
   */
  const playNow = () => {
    if (!meta || !videoId) return;
    if (cur?.infoHash != null && cur.fileIdx != null && resumable) {
      navigate(playUrl({ type, videoId, metaId: id, infoHash: cur.infoHash, fileIdx: cur.fileIdx, name: displayName, poster: meta.poster, background: episode?.thumbnail || meta.background, season: episode?.season, episode: episode?.episode }));
      return;
    }
    const best = streams?.sources.find((s) => s.id === streams.auto) || streams?.sources[0];
    if (best) play(best); else scrollToSources();
  };
  const download = async (s: Source) => {
    if (!meta || !videoId) return;
    try {
      await api.addDownload({ infoHash: s.infoHash, fileIdx: s.fileIdx, videoId, metaId: id, type: meta.type, name: displayName, poster: meta.poster, background: episode?.thumbnail || meta.background });
      toast('Downloading for later. It shows up on Home when ready.');
    } catch (e) { toast((e as Error).message, 'error', 6000); }
  };
  /** Start `s` on a TV for episode `e` (the selected one by default), from where it was left. */
  const startOn = async (deviceId: string, s: Source, e = episode) => {
    const vid = e?.id ?? videoId;
    if (!meta || !vid) return;
    const title = e ? episodeName(meta.name, e.season, e.episode, e.title) : displayName;
    await api.castPlay({ deviceId, infoHash: s.infoHash, fileIdx: s.fileIdx ?? 0, videoId: vid, title, poster: meta.poster, startTime: await resumeNow(vid, resumePoint(progress[vid]) ?? 0) });
  };
  const castTo = async (d: Tv, s: Source) => {
    if (!meta || !videoId) return;
    setBusyId(s.id);
    const ok = await sendToTv(d, (deviceId) => startOn(deviceId, s), `${resumable ? 'Continuing' : 'Casting'} on ${d.name}`);
    if (ok) setCastSrc(null);
    setBusyId(undefined);
  };
  const cast = (d: CastDevice) => { if (castSrc) void castTo(d, castSrc); };
  // "On TV" beside the big button: the remembered source (or the best pick); a single TV gets it straight away.
  const onlyTv = useSingleTv();
  const castNow = () => {
    const remembered = cur?.infoHash != null ? streams?.sources.find((s) => s.infoHash === cur.infoHash && (s.fileIdx ?? 0) === (cur.fileIdx ?? 0)) : undefined;
    const s = remembered || streams?.sources.find((x) => x.id === streams.auto) || streams?.sources[0];
    if (!s) { scrollToSources(); return; }
    if (onlyTv) void castTo(onlyTv, s); else setCastSrc(s);
  };
  // The TV button on an episode card: its remembered source, else the one this binge used, else the best pick.
  const sourceFor = async (e: Episode): Promise<Source | undefined> => {
    const r = await api.streams(type, e.id, target());
    const p = progress[e.id];
    let binge: string | null = null;
    try { binge = sessionStorage.getItem('kino.binge'); } catch { /* ignore */ }
    return (p?.infoHash != null ? r.sources.find((s) => s.infoHash === p.infoHash && (s.fileIdx ?? 0) === (p.fileIdx ?? 0)) : undefined) || episodeSource(r.sources, r.auto, binge);
  };
  const castEpisode = async (e: Episode) => {
    if (e.id === videoId) { castNow(); return; }
    selectEpisode(e);
    const name = `S${e.season} E${e.episode}`;
    if (onlyTv) {
      // Straight to the one TV, inside the tap (sendToTv arms the lock-screen remote before the sources are asked).
      await sendToTv(onlyTv, async (deviceId) => {
        const s = await sourceFor(e);
        if (!s) throw new Error(`No sources for ${name}`);
        await startOn(deviceId, s, e);
      }, `${resumePoint(progress[e.id]) != null ? 'Continuing' : 'Casting'} ${name} on ${onlyTv.name}`);
      return;
    }
    try { const s = await sourceFor(e); if (s) setCastSrc(s); else toast(`No sources for ${name}`); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  const toggleWatchlist = async () => {
    if (!meta) return;
    try {
      if (inWatchlist) await api.removeWatchlist(id); else await api.addWatchlist(id, { type: meta.type, name: meta.name, poster: meta.poster });
      setInWatchlist(!inWatchlist);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const toggleFollow = async () => {
    if (!meta) return;
    try {
      if (following) await api.unfollow(id); else await api.follow(id, { name: meta.name, poster: meta.poster });
      setFollowing(!following);
      toast(following ? 'Unfollowed' : 'Following. New episodes show on Home.');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const selectEpisode = (e: Episode) => {
    setVideoId(e.id);
    navigate(`/title/${type}/${id}?v=${encodeURIComponent(e.id)}`, true);
  };

  if (err && !meta) return <div><TopBar backTo="/" /><div className="err">{err} <button className="btn small" onClick={loadMeta}>Try again</button></div></div>;
  if (!meta) return <div><TopBar backTo="/" /><div className="center"><div className="spinner" role="status" aria-label="Loading" /></div></div>;
  const year = meta.year?.replace(/-$/, '');
  // A show still airing says when the next episode lands, right under the title.
  const airing = type === 'series' ? sortedEpisodes(meta.videos || []).find((e) => e.season > 0 && !isReleased(e)) : undefined;
  const airWhen = airing ? airLabel(airing.released) : '';
  const nextEpisodeLabel = (when: string) => `Next episode ${when === 'Today' || when === 'Tomorrow' ? when.toLowerCase() : when}`;
  // Landed on an episode you finished with nothing newer out: say so instead of offering a rewatch.
  // Picking an episode below (or arriving with one in the link) brings Play back.
  const caught = type === 'series' && !preselect && !resumable && meta.videos?.length ? caughtUp(meta.videos, progress) : null;
  const caughtWhen = caught?.upcoming ? airLabel(caught.upcoming.released) : '';
  // Weak: nothing scores positive with a handful of seeders. Streaming will stutter, so offer a download instead.
  const best = streams ? streams.sources.find((s) => s.id === streams.auto) || streams.sources[0] : undefined;
  const weak = !!(streams && best && !streams.sources.some((s) => s.score > 0 && (s.seeders ?? 0) >= 5));
  const playLabel = caught ? 'Caught up' : resumable ? `Continue${epLabel ? ` ${epLabel}` : ''}` : type === 'series' && episode ? `Play ${epLabel}` : 'Play';
  const playSub = caught ? (caughtWhen ? nextEpisodeLabel(caughtWhen) : 'Pick an episode to watch again')
    : resumable ? (left ? `${left} min left` : '') : loadingStreams ? 'Finding sources' : streams?.auto ? 'Best source' : '';
  return (
    <div className="title">
      {/* The artwork carries the title, facts, plot and actions on a blurred, darkened foot, so the episodes and sources
          start right under it instead of a screen further down. */}
      <div className="hero" style={meta.background ? { ['--art' as string]: `url(${meta.background})` } : undefined}>
        <div className="hero-fade" />
        <TopBar backTo="/" />
        <div className="hero-info">
        <div className="title-head">
          {meta.poster ? <img className="title-poster" src={meta.poster} alt="" /> : null}
          <div className="title-facts">
            {meta.logo ? <img className="title-logo" src={meta.logo} alt={meta.name} /> : <h1>{meta.name}</h1>}
            <div className="facts">
              {year ? <span>{year}</span> : null}
              {meta.runtime ? <span>{meta.runtime}</span> : null}
              {meta.imdbRating || ratings?.imdb ? <a className="chip accent rating-link" href={ratings?.imdbUrl || `https://www.imdb.com/title/${id}/`} target="_blank" rel="noopener" title={ratings?.imdb?.votes ? `${ratings.imdb.votes.toLocaleString()} votes on IMDb` : 'Open on IMDb'}>IMDb {ratings?.imdb?.rating?.toFixed(1) || meta.imdbRating} ↗</a> : null}
              {ratings?.rottenTomatoes ? <a className="chip rating-link rt" href={`https://www.rottentomatoes.com/search?search=${encodeURIComponent(meta.name)}`} target="_blank" rel="noopener" title="Rotten Tomatoes">🍅 {ratings.rottenTomatoes}</a> : null}
              {ratings?.metacritic ? <span className="chip rating-link mc" title="Metacritic">MC {ratings.metacritic}</span> : null}
              {airing && airWhen ? <span className="chip accent" title={`Season ${airing.season}, episode ${airing.episode}${airing.title ? `: ${airing.title}` : ''}`}>{nextEpisodeLabel(airWhen)}</span> : null}
              {meta.genres?.length ? <span className="genres">{meta.genres.join(', ')}</span> : null}
            </div>
          </div>
          <div className="title-actions">
            <button className={`btn big playnow${caught ? ' caught' : ' primary'}`} onClick={caught ? scrollToEpisodes : playNow} disabled={!caught && !videoId}>
              {caught ? <IconCheck /> : <IconPlay />}
              <span className="playnow-text"><span>{playLabel}</span>{playSub ? <small>{playSub}</small> : null}</span>
            </button>
            {caught ? null : (
              <button className="btn ghost castnow" onClick={castNow} disabled={!videoId || !!busyId} title={onlyTv ? `${resumable ? 'Continue' : 'Play'} on ${onlyTv.name}` : 'Pick a device'}>
                <IconCast /> <span className="lbl">{onlyTv ? `On ${onlyTv.name}` : 'On TV'}</span>
              </button>
            )}
            <button className={`btn${inWatchlist ? ' primary' : ' ghost'}`} onClick={toggleWatchlist} aria-pressed={inWatchlist}>{inWatchlist ? <IconCheck /> : <IconHeart />} <span className="lbl">{inWatchlist ? 'In watchlist' : 'Watchlist'}</span></button>
            {type === 'series' ? <button className={`btn${following ? ' primary' : ' ghost'}`} onClick={toggleFollow} aria-pressed={following}><IconBell /> <span className="lbl">{following ? 'Following' : 'Follow'}</span></button> : null}
            {meta.trailer ? <button className="btn ghost" onClick={() => setTrailer(true)}><IconFilm /> <span className="lbl">Trailer</span></button> : null}
          </div>
        </div>
        {meta.description ? <p className={`plot${plotOpen ? ' open' : ''}`} onClick={() => setPlotOpen(true)}>{meta.description}</p> : null}
        {meta.cast?.length ? <p className="cast">With {meta.cast.slice(0, 6).join(', ')}</p> : null}
        </div>
      </div>
      <div className="title-body">

        {type === 'series' && meta.videos?.length ? (
          <section id="episodes" className="ep-section">
            <h2 className="h">Episodes</h2>
            <EpisodePicker videos={meta.videos} progress={progress} selected={videoId} onSelect={selectEpisode} onPlay={playNow} onCast={(e) => void castEpisode(e)} onToggleWatched={toggleWatched} ratings={ratings?.episodes} fallback={meta.background || meta.poster} />
          </section>
        ) : null}

        {similar?.items.length ? (
          <section className="similar-section">
            <Row title={similar.title || 'More like this'} sub={similar.reason}>{similar.items.map((m) => <MetaCard key={m.id} m={m} />)}</Row>
          </section>
        ) : null}

        <section id="sources" className="src-section">
          <div className="sources-head">
            <div className="sources-title">
              <h2 className="h">{episode ? <><span className="ep-num">{epLabel}</span>{episode.title || `Episode ${episode.episode}`}</> : 'Sources'}</h2>
              {episode ? <div className="ep-meta">{[fmtDate(episode.released), ratings?.episodes?.[episode.id] ? `IMDb ${ratings.episodes[episode.id].rating.toFixed(1)}` : '', left ? `You stopped with ${left} min left` : ''].filter(Boolean).join(' · ')}</div> : left ? <div className="ep-meta">You stopped with {left} min left. Play resumes from there.</div> : null}
              {episode?.overview ? <p className="ep-overview">{episode.overview}</p> : null}
            </div>
            <button className="iconbtn" aria-label="Reload sources" onClick={loadStreams}><IconRefresh /></button>
          </div>
          {loadingStreams ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
          {streamsErr ? <div className="err">{streamsErr} <button className="btn small" onClick={loadStreams}>Try again</button></div> : null}
          {weak && best ? (
            <div className="weak">
              <div className="weak-text"><strong>Sources look weak.</strong> Few seeders, so streaming may stutter. Download the best one and watch it later instead?</div>
              <button className="btn small" onClick={() => download(best)}><IconDownload /> Download for later</button>
            </div>
          ) : null}
          {streams ? <SourceList data={streams} onPlay={play} onCast={(s) => setCastSrc(s)} onDownload={download} busyId={busyId} /> : null}
        </section>
      </div>
      {trailer && meta.trailer ? (
        <Sheet title={`${meta.name} trailer`} onClose={() => setTrailer(false)}>
          <div className="trailer"><iframe src={`https://www.youtube-nocookie.com/embed/${meta.trailer}?autoplay=1&rel=0`} title="Trailer" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen /></div>
        </Sheet>
      ) : null}
      {castSrc ? <CastPicker onPick={cast} onClose={() => setCastSrc(null)} busy={!!busyId} /> : null}
    </div>
  );
}
