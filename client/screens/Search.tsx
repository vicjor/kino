import { useEffect, useMemo, useRef, useState } from 'react';
import type { MetaPreview, BrowseGenres } from '../../server/types.js';
import { api, cached, urls } from '../lib/api';
import { MoodTiles } from '../components/MoodTiles';
import { browseUrl } from '../components/moods';
import { MetaCard, SkeletonCards } from '../components/Card';
import { IconSearch, IconX, IconMagnet } from '../components/Icons';
import { navigate } from '../lib/router';
import { kindCounts, fitKind, ofKind, type Kind } from '../lib/search-kinds';
import '../styles/search.css';
import { SegThumb } from '../components/SegThumb';

const LS_RECENT = 'kino.search.recent';
function readRecent(): string[] { try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch { return []; } }
function remember(q: string): string[] {
  const next = [q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  try { localStorage.setItem(LS_RECENT, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

export function Search() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MetaPreview[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [kind, setKind] = useState<Kind>('all');
  const [recent, setRecent] = useState<string[]>(readRecent);
  // Why the last search failed; over older titles it also says which query those are for. `attempt` bumps to run it again.
  const [err, setErr] = useState('');
  const [resultsFor, setResultsFor] = useState('');
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const last = useRef<{ q: string; hits: number }>({ q: '', hits: 0 });

  const [genres, setGenres] = useState<BrowseGenres | null>(() => cached<BrowseGenres>(urls.genres()) ?? null);
  useEffect(() => { inputRef.current?.focus(); api.browseGenres().then(setGenres).catch(() => undefined); }, []);
  useEffect(() => {
    // Bumped before the length check: clearing the field also drops an answer still on its way.
    const mine = ++seq.current;
    const query = q.trim();
    setErr('');
    if (query.length < 2) { setResults(null); setSearching(false); return; }
    setSearching(true);
    // Cleared by the next keystroke and on leaving the page: only the query you stopped at is searched.
    const t = window.setTimeout(() => {
      api.search(query).then((r) => { if (mine === seq.current) { setResults(r.results); setResultsFor(query); setSearching(false); last.current = { q: query, hits: r.results.length }; } })
        .catch((e) => { if (mine === seq.current) { setSearching(false); setErr((e as Error).message || 'The search did not go through.'); } });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, attempt]);
  // A query that found something is worth remembering when you leave the page.
  useEffect(() => () => { const l = last.current; if (l.q.length >= 3 && l.hits) remember(l.q); }, []);

  const counts = useMemo(() => kindCounts(results || []), [results]);
  // New results with none of the chosen kind: back to All while rendering, before anything paints.
  if (results && fitKind(kind, counts) !== kind) setKind('all');
  const shown = useMemo(() => ofKind(results || [], kind), [results, kind]);
  const idle = results === null && !searching && !err;
  return (
    <div className="screen search-screen">
      <div className="search-hero">
        <h1 className="search-title">Search</h1>
        <label className="search big">
          <IconSearch />
          <input ref={inputRef} type="search" placeholder="Movies and series" value={q} onChange={(e) => setQ(e.target.value)} autoCorrect="off" autoCapitalize="off" enterKeyHint="search"
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim().length >= 3) setRecent(remember(q.trim())); }} />
          {q ? <button className="iconbtn" aria-label="Clear" onClick={() => { setQ(''); inputRef.current?.focus(); }}><IconX size={18} /></button> : null}
        </label>
        {results && results.length ? (
          <div className="seasons search-kinds" role="group" aria-label="Kind">
            <SegThumb />
            {([['all', `All ${counts.all}`], ['movie', `Movies ${counts.movie}`], ['series', `Series ${counts.series}`]] as [Kind, string][]).map(([k, label]) => (
              <button key={k} aria-pressed={kind === k} className={`seg${kind === k ? ' on' : ''}`} onClick={() => setKind(k)} disabled={!counts[k]}>{label}</button>
            ))}
          </div>
        ) : null}
      </div>
      {idle ? (
        <div className="search-idle">
          {recent.length ? (
            <section className="search-recent">
              <div className="section-head"><h2>Recent</h2><button className="more link" onClick={() => { try { localStorage.removeItem(LS_RECENT); } catch { /* ignore */ } setRecent([]); }}>Clear</button></div>
              <div className="search-chips">{recent.map((r) => <button key={r} className="chip big" onClick={() => setQ(r)}>{r}</button>)}</div>
            </section>
          ) : null}
          <section className="section">
            <div className="section-head"><div className="section-title"><h2>In the mood for</h2><div className="section-sub">Pick a feeling, get a shelf</div></div></div>
            <div className="moods"><MoodTiles /></div>
          </section>
          <section className="section search-browse">
            <div className="section-head"><div className="section-title"><h2>Browse by genre</h2></div><a className="more see-all" href={`#${browseUrl('all')}`}>Everything</a></div>
            <div className="search-chips">
              <button className="chip big" onClick={() => navigate(browseUrl('movie'))}>Movies</button>
              <button className="chip big" onClick={() => navigate(browseUrl('series'))}>Series</button>
              {(genres?.movie || []).filter((g) => genres?.series.includes(g)).map((g) => <button key={g} className="chip big" onClick={() => navigate(browseUrl('all', { genre: g }))}>{g}</button>)}
            </div>
          </section>
          <div className="search-hint">
            <p>Type a title. Press <kbd className="keycap">/</kbd> anywhere to get here.</p>
            <button className="btn ghost" onClick={() => navigate('/magnet')}><IconMagnet size={18} /> Or paste a magnet link</button>
          </div>
        </div>
      ) : null}
      {searching && !results ? <div className="grid pad" aria-busy="true" aria-label="Searching"><SkeletonCards n={9} /></div> : null}
      {/* The button goes away as the retry starts, so focus goes back to the field instead of falling to the page. */}
      {err && !searching ? (
        <div className="err" role="alert">
          {err}{results ? ` Showing titles for “${resultsFor}”.` : ''} <button className="btn small" onClick={() => { setAttempt((n) => n + 1); inputRef.current?.focus(); }}>Try again</button>
        </div>
      ) : null}
      {results && !shown.length && !searching && !err ? <div className="empty"><strong>Nothing found</strong>Try the original-language title, or paste a magnet link.</div> : null}
      {shown.length ? <div className="grid pad">{shown.map((m) => <MetaCard key={m.type + m.id} m={m} />)}</div> : null}
    </div>
  );
}
