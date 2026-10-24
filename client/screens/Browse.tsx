import { useEffect, useRef, useState } from 'react';
import type { MetaPreview, BrowseGenres, BrowseSort, BrowseType } from '../../server/types.js';
import { api, cached, urls } from '../lib/api';
import { useRoute, navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { backOnline, useLoad } from '../lib/use-load';
import { MetaCard, SkeletonCards } from '../components/Card';
import { TopBar } from '../components/TopBar';
import { browseUrl, browseTitle } from '../components/moods';
import { IconSearch } from '../components/Icons';
import '../styles/browse.css';
import { SegThumb } from '../components/SegThumb';
import { yearPicks, readYears, sameYears, yearsPhrase, type Years } from '../lib/years';

/*
 * Browse: when you know roughly what you want. Kind, genre, sort; a grid that keeps
 * loading as you scroll. Titles you have seen are marked, not hidden, because here you
 * are looking, not being shown. The filters live in the URL, so a rail's "See all" and
 * a mood tile are just links to a page you can share or come back to.
 */

const SORTS: [BrowseSort, string][] = [['top', 'Popular'], ['rated', 'Top rated'], ['new', 'New']];

/** A chosen window that is not one of the quick picks, as the chip that holds it says it. */
const rangeLabel = (y: Years) => (y.from != null && y.to != null ? (y.from === y.to ? String(y.from) : `${y.from} to ${y.to}`) : y.from != null ? `Since ${y.from}` : `Before ${(y.to as number) + 1}`);

/** Any window of years: two fields and Show. Either may stay empty for an open end. */
function YearRange({ value, onApply }: { value?: Years; onApply: (y: Years | null) => void }) {
  const [from, setFrom] = useState(value?.from != null ? String(value.from) : '');
  const [to, setTo] = useState(value?.to != null ? String(value.to) : '');
  const now = new Date().getFullYear();
  return (
    <form className="year-range" onSubmit={(e) => { e.preventDefault(); onApply(readYears(new URLSearchParams({ from, to })) ?? null); }}>
      <label>From<input type="number" inputMode="numeric" min={1900} max={now + 1} placeholder="1990" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To<input type="number" inputMode="numeric" min={1900} max={now + 1} placeholder={String(now)} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <button className="btn small primary" type="submit">Show</button>
    </form>
  );
}
const TYPES: [BrowseType, string][] = [['all', 'All'], ['movie', 'Movies'], ['series', 'Series']];

export function Browse() {
  const route = useRoute();
  const t = route.parts[1]; const type: BrowseType = t === 'movie' || t === 'series' ? t : 'all';
  const genre = route.query.get('genre') || undefined;
  const so = route.query.get('sort'); const sort: BrowseSort = so === 'rated' || so === 'new' ? so : 'top';
  const years = readYears(route.query);
  const picks = yearPicks();
  const customOn = !!years && !picks.some((p) => sameYears(years, p));
  const [custom, setCustom] = useState(false);
  // No genre chips until the list loads, and none while it fails with nothing cached. The paged grid below keeps its own loader.
  const genres = useLoad(api.browseGenres, { initial: () => cached<BrowseGenres>(urls.genres()), visible: false }).data;
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Genre list for the kind in view: for "all", the genres both kinds share.
  const list = genres ? (type === 'movie' ? genres.movie : type === 'series' ? genres.series : genres.movie.filter((g) => genres.series.includes(g))) : [];

  const load = (p: number) => {
    const mine = ++seq.current;
    setBusy(true); setErr('');
    api.browse(type, { genre, sort, page: p, from: years?.from, to: years?.to }).then((r) => {
      if (mine !== seq.current) return;
      setItems((cur) => (p === 0 ? r.items : [...cur, ...r.items.filter((m) => !cur.some((x) => x.id === m.id))]));
      setPage(r.page); setMore(r.more);
    }).catch((e) => { if (mine === seq.current) setErr((e as Error).message); }).finally(() => { if (mine === seq.current) setBusy(false); });
  };
  useEffect(() => { setItems([]); setPage(0); setMore(false); load(0); }, [type, genre, sort, years?.from, years?.to]); // eslint-disable-line react-hooks/exhaustive-deps
  // Kino reachable again after a failed load: that page again, once, as useLoad does for the other screens.
  const online = useStore((s) => s.online);
  const was = useRef(online);
  useEffect(() => { if (backOnline(was.current, online, !!err)) load(items.length ? page + 1 : 0); was.current = online; }, [online]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the chosen genre chip in view when you land here from a link.
  useEffect(() => { railRef.current?.querySelector<HTMLElement>('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [genre, list.length]);
  // The next page arrives before you reach the bottom. Not after a failed page: that would retry in a
  // tight loop while the sentinel stays in view; the Load more button is the retry.
  useEffect(() => {
    const el = sentinel.current; if (!el || !more || busy || err) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(page + 1); }, { rootMargin: '900px 0px' });
    io.observe(el); return () => io.disconnect();
  }, [more, busy, page, err]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (next: { type?: BrowseType; genre?: string | null; sort?: BrowseSort; years?: Years | null }) => {
    const g = next.genre === null ? undefined : next.genre ?? genre;
    const y = next.years === null ? undefined : next.years ?? years;
    navigate(browseUrl(next.type ?? type, { genre: g, sort: next.sort ?? sort, from: y?.from, to: y?.to }), true);
  };
  return (
    <div className="screen browse">
      <TopBar backTo="/" title={browseTitle(type, genre, sort, yearsPhrase(years))} right={<button className="iconbtn" aria-label="Search" onClick={() => navigate('/search')}><IconSearch /></button>} />
      <div className="browse-controls">
        <div className="seasons" role="group" aria-label="Kind">
          <SegThumb />
          {TYPES.map(([k, label]) => <button key={k} aria-pressed={type === k} className={`seg${type === k ? ' on' : ''}`} onClick={() => go({ type: k })}>{label}</button>)}
        </div>
        <div className="seasons" role="group" aria-label="Sort">
          <SegThumb />
          {SORTS.map(([k, label]) => <button key={k} aria-pressed={sort === k} className={`seg${sort === k ? ' on' : ''}`} onClick={() => go({ sort: k })}>{label}</button>)}
        </div>
      </div>
      <div className="browse-genres" ref={railRef} role="group" aria-label="Genre">
        <button aria-pressed={!genre} className={`chip big${!genre ? ' on' : ''}`} onClick={() => go({ genre: null })}>All genres</button>
        {list.map((g) => <button key={g} aria-pressed={genre === g} className={`chip big${genre === g ? ' on' : ''}`} onClick={() => go({ genre: g })}>{g}</button>)}
      </div>
      <div className="browse-genres browse-years" role="group" aria-label="Release year">
        <button aria-pressed={!years} className={`chip big${!years ? ' on' : ''}`} onClick={() => { setCustom(false); go({ years: null }); }}>Any year</button>
        {picks.map((p) => {
          const on = sameYears(years, p);
          return <button key={p.key} aria-pressed={on} className={`chip big${on ? ' on' : ''}`} onClick={() => { setCustom(false); go({ years: on ? null : { from: p.from, to: p.to } }); }}>{p.label}</button>;
        })}
        <button aria-expanded={custom} className={`chip big${customOn ? ' on' : ''}`} onClick={() => setCustom((c) => !c)}>{customOn && years ? rangeLabel(years) : 'Custom years'}</button>
      </div>
      {custom ? <YearRange key={`${years?.from}-${years?.to}`} value={years} onApply={(y) => { setCustom(false); go({ years: y }); }} /> : null}
      {err && !items.length ? <div className="err">{err} <button className="btn small" onClick={() => load(0)}>Try again</button></div> : null}
      {items.length ? <div className="grid pad">{items.map((m) => <MetaCard key={m.type + m.id} m={m} />)}</div> : null}
      {!items.length && !busy && !err ? <div className="empty"><strong>Nothing here</strong>Try another genre, kind or years.</div> : null}
      {busy && !items.length ? <div className="grid pad" aria-busy="true" aria-label="Loading"><SkeletonCards /></div> : null}
      {busy && items.length ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
      <div ref={sentinel} className="browse-sentinel" aria-hidden="true" />
      {more && !busy ? <div className="center"><button className="btn ghost" onClick={() => load(page + 1)}>{err ? 'Try again' : 'Load more'}</button></div> : null}
    </div>
  );
}
