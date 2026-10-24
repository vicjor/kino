import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HomeResponse, MetaPreview, Progress, ReceiverInfo } from '../../server/types.js';
import { api, cached, urls } from '../lib/api';
import { useStore, setStore, toast } from '../lib/store';
import { volumeUnknown } from '../lib/cast-volume';
import { navigate, titleUrl } from '../lib/router';
import { closePalette } from '../lib/overlays';
import { restoreFocus, tabbables, tabWrap } from '../lib/focus';
import { IconSearch, IconHome, IconFilm, IconLibrary, IconMagnet, IconGear, IconCast, IconStop, IconPlay, IconPause, IconVol, IconMute, IconSpeaker, IconTv, IconRefresh } from './Icons';
import { byGroup } from '../lib/palette-order';
import { resumeUrl, minutesLeft } from './Card';
import '../styles/command-palette.css';

/*
 * Cmd+K. One input, everything Kino can do or reach:
 *   plain text   titles (live search) + matching commands
 *   >            commands only
 *   @            TVs and speakers only
 * Linear-style "g" chords work outside the palette too: g h / g s / g b / g l / g m / g ,
 * Those keys and Cmd+K itself listen from the start (onPaletteKey in lib/overlays.ts); this file loads on first open.
 */

type Group = 'Recent' | 'Continue watching' | 'Titles' | 'Go to' | 'Cast' | 'Commands';
/** Groups that are search results: never in Recent or the commands list, and ranked above commands. */
const searched = (g: Group) => g === 'Titles';
interface Cmd { id: string; group: Group; label: string; hint?: string; kbd?: string[]; icon: ReactNode; art?: string; keywords?: string; run: () => void | Promise<unknown>; keep?: boolean }

const RECENT_KEY = 'kino.palette.recent';
const OUT_MS = 160;

function recent(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function remember(id: string): void { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 5))); } catch { /* private mode */ } }

/** Subsequence fuzzy match. Returns score (higher is better) and matched indices, or null. */
function fuzzy(q: string, text: string): { score: number; idx: number[] } | null {
  if (!q) return { score: 0, idx: [] };
  const t = text.toLowerCase(); const s = q.toLowerCase();
  let ti = 0; let score = 0; let streak = 0; const idx: number[] = [];
  for (let si = 0; si < s.length; si++) {
    const ch = s[si];
    if (ch === ' ') { streak = 0; continue; }
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const boundary = at === 0 || /[\s.·:-]/.test(t[at - 1]);
    // Only accept a jump when it lands on a word start; scattered letters are not a match.
    if (at > ti && !boundary && si > 0) return null;
    if (at - ti > 24) return null;
    score += 10 + (at === ti ? 8 + streak * 3 : 0) + (boundary ? 12 : 0) - Math.min(6, at - ti);
    streak = at === ti ? streak + 1 : 0;
    idx.push(at); ti = at + 1;
  }
  return { score: score + Math.max(0, 20 - t.length / 4), idx };
}

function Mark({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>;
  const set = new Set(idx);
  return <>{[...text].map((c, i) => set.has(i) ? <b key={i}>{c}</b> : c)}</>;
}

/** Continue watching as Home last saw it (api.ts keeps the last /api/home). */
const homeCw = (): Progress[] => cached<HomeResponse>(urls.home())?.continueWatching ?? [];
/** When the palette last asked for Home itself: opening it again within a minute uses what is there. */
let homeAskedAt = 0;

export function CommandPalette() {
  const open = useStore((s) => s.palOpen);
  // Still on screen for the exit animation after `open` went false, whoever closed it (a pick, Esc, Cmd+K).
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  // Opened again while the exit animation runs: stay up.
  if (open !== wasOpen) { setWasOpen(open); setLeaving(!open); }
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [cw, setCw] = useState<Progress[]>(homeCw);
  const [titles, setTitles] = useState<MetaPreview[]>([]);
  const [searching, setSearching] = useState(false);
  const receivers = useStore((s) => s.receivers);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // What had focus before the palette opened; it gets it back on close.
  const opener = useRef<Element | null>(null);

  const hide = () => {
    if (!open) return;
    restoreFocus(opener.current, box.current);
    closePalette();
  };
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => { setLeaving(false); setQ(''); setActive(0); }, OUT_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    setTimeout(() => input.current?.focus(), 10);
    document.body.style.overflow = 'hidden';
    setCw(homeCw());
    if (Date.now() - homeAskedAt > 60_000) { homeAskedAt = Date.now(); api.home().then((h) => setCw(h.continueWatching)).catch(() => { homeAskedAt = 0; }); }
    return () => { document.body.style.overflow = ''; restoreFocus(opener.current, box.current); opener.current = null; };
  }, [open]);

  const mode = q.startsWith('>') ? 'commands' : q.startsWith('@') ? 'cast' : 'all';
  const term = mode === 'all' ? q.trim() : q.slice(1).trim();

  // Live title search, debounced. An answer for a term you already typed past is dropped.
  useEffect(() => {
    if (mode !== 'all' || term.length < 2) { setTitles([]); setSearching(false); return; }
    setSearching(true);
    let dead = false;
    const t = setTimeout(() => {
      api.search(term).then((r) => { if (!dead) setTitles(r.results.slice(0, 6)); }).catch(() => { if (!dead) setTitles([]); }).finally(() => { if (!dead) setSearching(false); });
    }, 180);
    return () => { dead = true; clearTimeout(t); };
  }, [term, mode]);

  const go = (hash: string) => { navigate(hash); };
  const castCmd = (id: string, c: 'stop' | 'pause' | 'play' | 'volume', body?: { muted?: boolean }) =>
    api.castReceiverCmd(id, c, body).then((r) => setStore((s) => ({ receivers: (s.receivers || []).map((x) => (x.id === r.id ? r : x)) }))).catch((e) => toast((e as Error).message, 'error'));

  const all = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = [
      { id: 'nav.home', group: 'Go to', label: 'Home', kbd: ['G', 'H'], icon: <IconHome />, run: () => go('/') },
      { id: 'nav.search', group: 'Go to', label: 'Search', kbd: ['G', 'S'], icon: <IconSearch />, run: () => go('/search') },
      { id: 'nav.browse', group: 'Go to', label: 'Browse by genre', kbd: ['G', 'B'], icon: <IconFilm />, keywords: 'discover genres moods movies series', run: () => go('/browse/all') },
      { id: 'nav.library', group: 'Go to', label: 'Library', kbd: ['G', 'L'], icon: <IconLibrary />, keywords: 'watchlist following', run: () => go('/library') },
      { id: 'nav.magnet', group: 'Go to', label: 'Play a magnet link', kbd: ['G', 'M'], icon: <IconMagnet />, keywords: 'torrent paste', run: () => go('/magnet') },
      { id: 'nav.settings', group: 'Go to', label: 'Settings', kbd: ['G', ','], icon: <IconGear />, keywords: 'addons subtitles cache preferences', run: () => go('/settings') },
    ];
    const playing = (receivers || []).filter((r) => r.online && r.app);
    const cast: Cmd[] = [
      { id: 'cast.open', group: 'Cast', label: 'Open Cast controls', kbd: ['G', 'C'], icon: <IconCast />, keywords: 'chromecast speakers devices', run: () => setStore({ ccOpen: true }) },
      ...(playing.length ? [{ id: 'cast.stopall', group: 'Cast' as Group, label: `Stop everything (${playing.length} device${playing.length === 1 ? '' : 's'})`, icon: <IconStop />, keywords: 'panic silence', run: () => api.castStopAll().then((r) => setStore({ receivers: r })).catch((e) => toast((e as Error).message, 'error')) }] : []),
      { id: 'cast.refresh', group: 'Cast', label: 'Rescan for TVs', icon: <IconRefresh />, keywords: 'chromecast devices', run: () => api.castReceivers(true).then((r) => { setStore({ receivers: r }); toast(`${r.length} device${r.length === 1 ? '' : 's'} found`); }).catch((e) => toast((e as Error).message, 'error')) },
    ];
    const devices: Cmd[] = (receivers || []).filter((r) => r.online && !r.audioOnly).flatMap((r: ReceiverInfo) => {
      const Icon = r.audioOnly ? IconSpeaker : IconTv;
      const out: Cmd[] = [];
      const st = r.media?.state;
      if (r.media) out.push({ id: `dev.${r.id}.pp`, group: 'Cast', label: `${st === 'PLAYING' ? 'Pause' : 'Resume'} ${r.name}`, hint: r.media.title, icon: st === 'PLAYING' ? <IconPause /> : <IconPlay />, keywords: r.model, run: () => castCmd(r.id, st === 'PLAYING' ? 'pause' : 'play'), keep: true });
      if (r.app) out.push({ id: `dev.${r.id}.stop`, group: 'Cast', label: `Stop ${r.name}`, hint: r.media?.title || r.app.name, icon: <IconStop />, keywords: r.model, run: () => castCmd(r.id, 'stop'), keep: true });
      if (!volumeUnknown(r)) out.push({ id: `dev.${r.id}.mute`, group: 'Cast', label: `${r.muted ? 'Unmute' : 'Mute'} ${r.name}`, hint: `${Math.round(r.volume * 100)}%`, icon: r.muted ? <IconMute /> : <IconVol />, art: undefined, keywords: `${r.model} volume`, run: () => castCmd(r.id, 'volume', { muted: !r.muted }), keep: true });
      if (!out.length) out.push({ id: `dev.${r.id}.open`, group: 'Cast', label: r.name, hint: 'Idle', icon: <Icon />, keywords: r.model, run: () => setStore({ ccOpen: true }) });
      return out;
    });
    const resume: Cmd[] = cw.slice(0, 5).map((p) => { const left = minutesLeft(p); return { id: `cw.${p.videoId}`, group: 'Continue watching', label: p.name, hint: left ? `${left} min left` : '', icon: <IconPlay />, art: p.poster, keywords: 'resume continue', run: () => go(resumeUrl(p)) }; });
    const found: Cmd[] = titles.map((m) => ({ id: `title.${m.type}.${m.id}`, group: 'Titles', label: m.name, hint: [m.type === 'series' ? 'Series' : 'Movie', m.year?.replace(/-$/, ''), m.imdbRating ? `★ ${m.imdbRating}` : ''].filter(Boolean).join(' · '), icon: <IconSearch />, art: m.poster, run: () => go(titleUrl(m.type, m.id)) }));
    return [...resume, ...found, ...nav, ...cast, ...devices];
  }, [receivers, cw, titles]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const pool = all.filter((c) => mode === 'all' ? true : mode === 'commands' ? !searched(c.group) && c.group !== 'Continue watching' : c.group === 'Cast');
    if (!term) {
      const rec = recent().map((id) => pool.find((c) => c.id === id)).filter((c): c is Cmd => !!c && !searched(c.group));
      const rest = pool.filter((c) => !rec.includes(c) && (mode === 'cast' || !c.id.startsWith('dev.')));
      return [...rec.map((c) => ({ ...c, group: 'Recent' as Group, idx: [] as number[] })), ...rest.map((c) => ({ ...c, idx: [] as number[] }))];
    }
    const scored = pool.map((c) => {
      if (searched(c.group)) { const m = fuzzy(term, c.label); return { ...c, idx: m?.idx || [], score: 400 + (m?.score || 0) }; }
      const m = fuzzy(term, c.label) || (c.keywords ? fuzzy(term, c.keywords) && { score: 1, idx: [] as number[] } : null);
      return m ? { ...c, idx: m.idx, score: m.score } : null;
    }).filter((x): x is Cmd & { idx: number[]; score: number } => !!x);
    return byGroup(scored);
  }, [all, term, mode]);

  useEffect(() => { setActive(0); }, [rows.length, term]);
  useEffect(() => { const el = list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`); el?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const pick = (c: Cmd) => { remember(c.id); void c.run(); if (!c.keep) hide(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = rows[active]; if (c) pick(c); else if (term && mode === 'all') { hide(); go(`/search?q=${encodeURIComponent(term)}`); } }
    else if (e.key === 'Escape') { e.preventDefault(); if (q) setQ(''); else hide(); }
    else if (e.key === 'Backspace' && !q) hide();
  };
  // Modal: Tab cycles inside. The box takes focus itself (tabIndex -1) when a click lands on no control, so focus never
  // falls to the page behind and Tab is always caught here. Esc from the box closes it too, not a sheet underneath.
  // A click on a row is not one of those: rows cancel the mousedown, so focus (and the arrow keys) stay in the input.
  const onBoxKey = (e: React.KeyboardEvent) => {
    const el = box.current;
    if (e.key === 'Escape' && !e.isDefaultPrevented()) { e.preventDefault(); hide(); return; }
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || !el) return;
    const stops = tabbables(el);
    const to = tabWrap(stops.indexOf(document.activeElement as HTMLElement), stops.length, e.shiftKey);
    if (to == null) return;
    e.preventDefault();
    (to < 0 ? el : stops[to]).focus();
  };

  if (!open && !leaving) return null;
  let lastGroup: Group | null = null;
  return (
    <div className={`pal-back${leaving ? ' out' : ''}`} onMouseDown={hide}>
      <div ref={box} className="pal" role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1} style={{ outline: 'none' }} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onBoxKey}>
        <div className="pal-input">
          <span className="pal-mode">{mode === 'commands' ? 'Commands' : mode === 'cast' ? 'Cast' : <IconSearch />}</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search titles or control the TV" spellCheck={false} autoComplete="off" role="combobox" aria-expanded aria-controls="pal-list" aria-activedescendant={rows[active] ? `pal-${rows[active].id}` : undefined} />
          {searching ? <span className="pal-spin" /> : <kbd className="pal-esc">esc</kbd>}
        </div>
        <div ref={list} id="pal-list" className="pal-list" role="listbox">
          {rows.length ? rows.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null; lastGroup = c.group;
            return (
              <div key={c.id}>
                {head ? <div className="pal-group">{head}</div> : null}
                <div id={`pal-${c.id}`} data-i={i} role="option" aria-selected={i === active} className={`pal-row${i === active ? ' active' : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
                  {c.art ? <img className="pal-art" src={c.art} alt="" loading="lazy" /> : <span className="pal-ico">{c.icon}</span>}
                  <span className="pal-label"><Mark text={c.label} idx={c.idx} /></span>
                  {c.hint ? <span className="pal-hint">{c.hint}</span> : null}
                  {c.kbd ? <span className="pal-kbd">{c.kbd.map((k) => <kbd key={k}>{k}</kbd>)}</span> : null}
                  {i === active ? <kbd className="pal-enter">↵</kbd> : null}
                </div>
              </div>
            );
          }) : (
            <div className="pal-empty">{searching ? 'Searching…' : <>No matches for <b>{term}</b>{mode === 'all' ? <span>. Press ↵ to search anyway.</span> : null}</>}</div>
          )}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>&gt;</kbd> commands</span>
          <span><kbd>@</kbd> cast</span>
          <span className="pal-brand"><kbd>⌘</kbd><kbd>K</kbd></span>
        </div>
      </div>
    </div>
  );
}
