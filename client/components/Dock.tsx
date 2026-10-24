import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useRoute, navigate } from '../lib/router';
import { useStore, setStore } from '../lib/store';
import { openPalette } from '../lib/overlays';
import { Spring, SPRINGS, VelocityTracker, project, rubberband } from '../lib/spring';
import { Brand } from './Brand';
import { IconHome, IconSearch, IconLibrary, IconGear, IconCast, IconGrid } from './Icons';
import { barShown } from './NowPlayingBar';
import '../styles/dock.css';

/*
 * Kino's three places. Search, the TVs and Settings are tools, not places: they sit beside the bar as their own glass
 * buttons (iOS 26 gives Search its own circle). Magnet links are a Home and palette action.
 */
const TABS = [
  { key: '', label: 'Home', path: '/', Icon: IconHome },
  { key: 'browse', label: 'Browse', path: '/browse/all', Icon: IconGrid },
  { key: 'library', label: 'Library', path: '/library', Icon: IconLibrary },
] as const;

type Box = { x: number; y: number; w: number; h: number };
const ROUTE_TABS = ':scope > .dock-tab';
const boxOf = (el: HTMLElement): Box => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
const wide = () => window.matchMedia('(min-width: 900px)').matches;

/**
 * The selection lens: one glass bubble behind the tabs that springs to the chosen one, position and size as four
 * springs, so a tab picked while it is still travelling turns from where it is. On a phone it can be dragged along the
 * bar (as in iOS): it follows the finger, resists past the ends, and on release lands on the tab the flick was heading for.
 */
function useLens(inner: React.RefObject<HTMLDivElement | null>, lens: React.RefObject<HTMLSpanElement | null>, active: string) {
  const s = useRef<Record<keyof Box, Spring> | null>(null);
  const springs = () => {
    if (s.current) return s.current;
    const el = lens.current!;
    const at: Box = { x: 0, y: 0, w: 0, h: 0 };
    const draw = () => { el.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`; el.style.width = `${at.w}px`; el.style.height = `${at.h}px`; };
    const mk = (k: keyof Box) => new Spring(0, (v) => { at[k] = v; draw(); });
    return (s.current = { x: mk('x'), y: mk('y'), w: mk('w'), h: mk('h') });
  };
  const place = (animate: boolean, velocityX?: number) => {
    const el = lens.current; const box = inner.current; if (!el || !box) return;
    const tab = box.querySelector<HTMLElement>(':scope > .dock-tab.active');
    if (!tab) { el.classList.remove('ready'); return; }
    const sp = springs();
    const t = boxOf(tab);
    const show = animate && el.classList.contains('ready');
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      if (!show) { sp[k].set(t[k]); continue; }
      if (sp[k].goal !== t[k] || (k === 'x' && velocityX !== undefined)) sp[k].to(t[k], { params: velocityX !== undefined ? SPRINGS.fling : SPRINGS.snappy, velocity: k === 'x' ? velocityX : undefined });
    }
    el.classList.add('ready');
  };
  useLayoutEffect(() => place(true), [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const box = inner.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    // The bar shrinks and grows (scrolling on a phone, a resize): the lens follows every frame of that.
    const ro = new ResizeObserver(() => place(true));
    ro.observe(box);
    for (const c of box.children) ro.observe(c);
    return () => { ro.disconnect(); if (s.current) for (const sp of Object.values(s.current)) sp.stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const drag = useRef<{ id: number; x: number; y: number; from: number; claimed: boolean } | null>(null);
  const tracker = useRef(new VelocityTracker());
  const scrubbed = useRef(false);
  const tabs = () => [...(inner.current?.querySelectorAll<HTMLElement>(ROUTE_TABS) || [])].filter((t) => t.offsetWidth > 0);
  const nearestTab = (center: number) => tabs().reduce<HTMLElement | null>((best, t) => (!best || Math.abs(t.offsetLeft + t.offsetWidth / 2 - center) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - center) ? t : best), null);
  const mark = (center: number | null) => { const n = center == null ? null : nearestTab(center); for (const t of tabs()) t.classList.toggle('under', t === n); };
  const onDown = (e: RPointerEvent) => {
    if (wide() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!(e.target as HTMLElement).closest('.dock-tab') || !lens.current?.classList.contains('ready')) return;
    scrubbed.current = false;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: springs().x.value, claimed: false };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.claimed) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - d.y)) return;
      d.claimed = true;
      inner.current?.setPointerCapture(e.pointerId);
      inner.current?.classList.add('scrubbing');
      tracker.current.reset();
    }
    const sp = springs();
    const all = tabs(); const first = all[0], last = all[all.length - 1];
    const min = first.offsetLeft, max = last.offsetLeft + last.offsetWidth - sp.w.value;
    const raw = d.from + dx;
    const x = raw < min ? min - rubberband(min - raw, 120) : raw > max ? max + rubberband(raw - max, 120) : raw;
    sp.x.set(x);
    tracker.current.add(x, performance.now());
    mark(x + sp.w.value / 2);
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.claimed) return;
    scrubbed.current = true;
    inner.current?.classList.remove('scrubbing');
    mark(null);
    const sp = springs();
    const v = tracker.current.velocity(performance.now());
    const to = nearestTab(sp.x.value + sp.w.value / 2 + project(v, 0.99));
    const tab = TABS.find((t) => t.key === to?.dataset.tab);
    if (!to || !tab || tab.key === active) { place(true, v); return; }
    sp.x.to(to.offsetLeft, { velocity: v, params: SPRINGS.fling });
    navigate(tab.path, false, 'none');
  };
  const onClickCapture = (e: React.MouseEvent) => { if (scrubbed.current) { scrubbed.current = false; e.stopPropagation(); e.preventDefault(); } };
  return { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onClickCapture };
}

/**
 * Phones: the bar steps aside while you read. Scrolling down shrinks it to the tab you are on, scrolling up (or reaching
 * the top) brings it back, as iOS 26 does. A little hysteresis so a jittery thumb does not flap it.
 */
function useMinimizeOnScroll(path: string): [boolean, (min: boolean) => void] {
  const [min, setMin] = useState(false);
  useEffect(() => { setMin(false); }, [path]);
  useEffect(() => {
    let last = window.scrollY; let travel = 0;
    const onScroll = () => {
      const y = window.scrollY; const dy = y - last; last = y;
      if (wide() || y < 40) { travel = 0; setMin(false); return; }
      travel = Math.sign(dy) === Math.sign(travel) ? travel + dy : dy;
      if (travel > 36) setMin(true); else if (travel < -24) setMin(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return [min, setMin];
}

/**
 * Phones, while something plays: the mini player takes the bar's row, between the tab you are on and Search, as iOS 26
 * does with a minimized tab bar, so the page loses one row instead of two. A tap on that tab opens the whole bar (the
 * player steps back up above it) until you go somewhere or scroll down.
 */
function useInlinePlayer(path: string, scrollMin: boolean): [boolean, () => void] {
  const bar = useStore(barShown);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { if (scrollMin) setOpen(false); }, [scrollMin]);
  return [bar && !open, () => setOpen(true)];
}

export function Dock() {
  const route = useRoute();
  const head = route.parts[0] || '';
  const ccOpen = useStore((s) => s.ccOpen);
  const casting = useStore((s) => s.cast.active || (s.receivers || []).some((r) => r.online && !r.audioOnly && r.media?.state === 'PLAYING'));
  const downloading = useStore((s) => (s.downloads || []).some((d) => d.active && !d.done && !d.error));
  const inner = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  // The magnet page hangs off Home: Home stays lit there.
  const lit = head === 'magnet' ? '' : head;
  const scrub = useLens(inner, lens, lit);
  const [scrollMin, setScrollMin] = useMinimizeOnScroll(route.path);
  const [inline, openBar] = useInlinePlayer(route.path, scrollMin);
  const min = scrollMin || inline;
  // The tab a shrunk bar keeps: the one you are on, or Home from Search and Settings, which are not tabs.
  const keep = TABS.some((t) => t.key === lit) ? lit : '';
  return (
    <nav className={`dock${min ? ' min' : ''}${inline ? ' inline' : ''}`} aria-label="Primary">
      <a className="dock-brand" href="#/" aria-label="Kino home" onClick={(e) => { e.preventDefault(); navigate('/', false, 'none'); }}><Brand /></a>
      <div className="dock-inner" ref={inner} {...scrub}>
        <span className="dock-lens" ref={lens} aria-hidden="true" />
        {TABS.map(({ key, label, path, Icon }) => {
          const active = lit === key;
          return (
            <button key={key} data-tab={key} className={`dock-tab${active ? ' active' : ''}${key === keep ? ' keep' : ''}${key === 'library' && downloading ? ' downloading' : ''}`} aria-current={active ? 'page' : undefined} title={key === 'library' && downloading ? 'A download is running' : undefined}
              onClick={() => { if (min && key === keep) { setScrollMin(false); openBar(); } else if (head !== key) navigate(path, false, 'none'); }}>
              <span className="dock-ico"><Icon size={22} /></span>
              <span className="dock-label">{label}</span>
            </button>
          );
        })}
      </div>
      <span className="dock-gap" aria-hidden="true" />
      <div className="dock-tools">
        <button className={`dock-tool dock-search${head === 'search' ? ' active' : ''}`} aria-label="Search"
          onClick={() => { if (wide()) openPalette(); else if (head !== 'search') navigate('/search', false, 'none'); }}>
          <IconSearch size={20} /><span className="dock-tool-label">Search</span><kbd className="dock-kbd" aria-hidden="true">⌘K</kbd>
        </button>
        <button className={`dock-tool dock-cast${ccOpen ? ' active' : ''}${casting ? ' casting' : ''}`} aria-label="TVs" aria-pressed={ccOpen} title="TVs" onClick={() => setStore({ ccOpen: !ccOpen, ccOrigin: null })}>
          <IconCast size={20} />
        </button>
        <button className={`dock-tool dock-gear${head === 'settings' ? ' active' : ''}`} aria-label="Settings" title="Settings" onClick={() => { if (head !== 'settings') navigate('/settings', false, 'none'); }}>
          <IconGear size={20} />
        </button>
      </div>
    </nav>
  );
}
