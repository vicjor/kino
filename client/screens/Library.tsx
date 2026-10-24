import { useEffect, useMemo, useRef } from 'react';
import type { HomeResponse, MetaPreview, Progress } from '../../server/types.js';
import { api, cached, urls } from '../lib/api';
import { useStore, setStore, getStore } from '../lib/store';
import { useLoad } from '../lib/use-load';
import { Row } from '../components/Row';
import { MetaCard, ProgressCard, DownloadCard, UpcomingCard, WidePoster, splitProgressName } from '../components/Card';
import { navigate, titleUrl, useRoute } from '../lib/router';
import { relTime, episodeCode } from '../lib/format';
import { isFinished } from '../lib/progress';
import { IconCheck } from '../components/Icons';
import '../styles/library.css';

/** Something you watched: finished ones get a check, unfinished ones show what is left. Tap opens the title. */
function HistoryCard({ p }: { p: Progress }) {
  const done = isFinished(p);
  const { show, episode } = splitProgressName(p);
  const label = p.season != null && p.episode != null ? episodeCode(p.season, p.episode) : '';
  const pct = p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
  return (
    <button className="card wide" onClick={() => navigate(titleUrl(p.type, p.metaId, p.videoId))}>
      <WidePoster src={p.background || p.poster} name={p.name}>
        {label ? <span className="chip strong tag">{label}</span> : null}
        {done ? <span className="hist-done" aria-label="Watched"><IconCheck /></span> : <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
      </WidePoster>
      <div className="name">{show}</div>
      <div className="sub">{[episode, done ? `Watched ${relTime(p.updatedAt)}` : relTime(p.updatedAt)].filter(Boolean).join(' · ')}</div>
    </button>
  );
}

export function Library() {
  // Paint the last Home answer at once (Home fetches the same one); the fetch refreshes it. Downloads arrive over SSE;
  // while they never have, each Home load asks for them too.
  const homeLoad = useLoad(() => {
    if (getStore().downloads == null) api.downloads().then((d) => setStore({ downloads: d })).catch(() => undefined);
    return api.home();
  }, { initial: () => cached<HomeResponse>(urls.home()) });
  const followingLoad = useLoad(api.following);
  const historyLoad = useLoad(api.history);
  // Per part. An error only shows while that part has nothing on screen: a failed refresh keeps the old rows.
  const home = homeLoad.data, following = followingLoad.data, history = historyLoad.data;
  const downloads = useStore((s) => s.downloads);
  const retry = () => { homeLoad.retry(); followingLoad.retry(); historyLoad.retry(); };

  // Settings links here with show=downloads (downloads past the cache limit): once the rail is in, bring it into view.
  const showDownloads = useRoute().query.get('show') === 'downloads';
  const shown = useRef(false);
  const hasDownloads = !!(home && downloads && downloads.length);
  useEffect(() => {
    if (!showDownloads || !hasDownloads || shown.current) return;
    shown.current = true;
    document.getElementById('lib-downloads')?.scrollIntoView({ block: 'start' });
  }, [showDownloads, hasDownloads]);

  const watched = useMemo(() => (history || []).filter((p) => !home?.continueWatching.some((c) => c.videoId === p.videoId)), [history, home]);
  // Nothing saved only once every part has answered: a part that failed is not an empty one.
  const empty = home && following && history && !home.continueWatching.length && !home.watchlist.length && !following.length && !watched.length && !(downloads && downloads.length);
  const homeErr = home ? '' : homeLoad.error;
  const missing = [!following && followingLoad.error ? 'the shows you follow' : '', !history && historyLoad.error ? 'your watch history' : ''].filter(Boolean);
  const errText = homeErr || (missing.length ? `Could not load ${missing.join(' or ')}.` : '');
  const summary = home ? [
    home.continueWatching.length ? `${home.continueWatching.length} in progress` : '',
    home.watchlist.length ? `${home.watchlist.length} saved` : '',
    following?.length ? `${following.length} followed` : '',
    downloads && downloads.length ? `${downloads.length} download${downloads.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') : '';
  return (
    <div className="screen library">
      <header className="screen-head lib-head"><h1>Library</h1>{summary ? <span className="lib-summary">{summary}</span> : null}</header>
      {errText ? <div className="err" role="alert">{errText} <button className="btn small" onClick={retry}>Try again</button></div> : null}
      {empty ? <div className="empty"><strong>Nothing saved yet</strong>Watch something, save a title to the watchlist or follow a show. They all land here.</div> : null}
      {home ? (
        <>
          <Row title="Continue watching" wide>{home.continueWatching.map((p) => <ProgressCard key={p.videoId} p={p} />)}</Row>
          {downloads && downloads.length ? <div id="lib-downloads" style={{ scrollMarginTop: 'var(--sat)' }}><Row title="Downloads" wide>{downloads.map((d) => <DownloadCard key={d.key} d={d} />)}</Row></div> : null}
          {home.newEpisodes.length ? (
            <Row title="New episodes" wide>
              {home.newEpisodes.map(({ show, episode }) => (
                <button key={episode.id} className="card wide" onClick={() => navigate(titleUrl('series', show.id, episode.id))}>
                  <WidePoster src={episode.thumbnail || show.background} name={show.name}><span className="chip strong tag">{episodeCode(episode.season, episode.episode)}</span></WidePoster>
                  <div className="name">{show.name}</div><div className="sub">{episode.title}</div>
                </button>
              ))}
            </Row>
          ) : null}
          {home.upcoming?.length ? <Row title="Coming up" sub="Next episodes of the shows you watch" wide>{home.upcoming.map((u) => <UpcomingCard key={u.episode.id} u={u} />)}</Row> : null}
          <Row title="Watchlist" empty="Tap the heart on any title to save it.">{home.watchlist.map((m) => <MetaCard key={m.id} m={m} />)}</Row>
          {following ? <Row title="Following" empty="Follow a series to track new episodes.">{following.map((f) => <MetaCard key={f.id} m={{ id: f.id, type: 'series', name: f.name, poster: f.poster } as MetaPreview} />)}</Row> : null}
          {watched.length ? <Row title="Watched" wide>{watched.map((p) => <HistoryCard key={p.videoId} p={p} />)}</Row> : null}
        </>
      ) : !homeErr ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
    </div>
  );
}
