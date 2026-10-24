import type { JSX, ReactNode } from 'react';
import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useRoute, navigate, back, navKind } from './lib/router';
import { useStore, setStore, dismissToast } from './lib/store';
import { onPaletteKey } from './lib/overlays';
import { isTouch } from './lib/player-caps';
import { startSse } from './lib/sse';
import { api } from './lib/api';
import { shouldShowWalkthrough } from './lib/walkthrough';
import { Home } from './screens/Home';
import { Dock } from './components/Dock';
import { Brand } from './components/Brand';
import { NowPlayingBar } from './components/NowPlayingBar';
import { CastHotkeys } from './components/CastHotkeys';
import { CastUpNext } from './components/CastUpNext';
import { CastSkipIntro } from './components/SkipIntro';
import { LockRemote } from './components/LockRemote';
import { CastCenter, CommandPalette, CastPicker, CastShortcutsSheet } from './components/LazyOverlays';
import { EscapeNav } from './components/EscapeNav';
import { Ambient } from './components/Ambient';

// Home ships in the entry chunk; every other screen arrives when first opened, so the
// first paint on a phone only parses what Home needs. The likely next stops are warmed on idle.
const loaders = {
  title: () => import('./screens/Title'),
  player: () => import('./screens/Player'),
  search: () => import('./screens/Search'),
  browse: () => import('./screens/Browse'),
  library: () => import('./screens/Library'),
  settings: () => import('./screens/Settings'),
  magnet: () => import('./screens/Magnet'),
  onboarding: () => import('./screens/Onboarding'),
};
const Title = lazy(() => loaders.title().then((m) => ({ default: m.Title })));
const Player = lazy(() => loaders.player().then((m) => ({ default: m.Player })));
const Search = lazy(() => loaders.search().then((m) => ({ default: m.Search })));
const Browse = lazy(() => loaders.browse().then((m) => ({ default: m.Browse })));
const Library = lazy(() => loaders.library().then((m) => ({ default: m.Library })));
const Settings = lazy(() => loaders.settings().then((m) => ({ default: m.Settings })));
const Magnet = lazy(() => loaders.magnet().then((m) => ({ default: m.Magnet })));
const Onboarding = lazy(() => loaders.onboarding().then((m) => ({ default: m.Onboarding })));

function warmScreens() {
  const go = () => {
    for (const k of ['title', 'search', 'library', 'player'] as const) void loaders[k]().catch(() => undefined);
    // Overlays too, so a first open is as quick as before they left the first load. The palette only where it opens:
    // Cmd+K, or the Search tab on a wide screen.
    for (const o of [CastCenter, CastPicker, CastShortcutsSheet]) o.preload();
    if (!isTouch || window.matchMedia('(min-width: 720px)').matches) CommandPalette.preload();
  };
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(go, { timeout: 4000 }); else window.setTimeout(go, 2000);
}

/** Shown only while a screen's code is on its way. Blank at first, a spinner if it takes a while. */
function ScreenFallback({ dark }: { dark?: boolean }) {
  return <div className={`screen-wait${dark ? ' dark' : ''}`}><div className="spinner" /></div>;
}

/**
 * A screen whose code did not arrive (the Mac asleep, the phone between networks) or that threw while
 * rendering. Without this React unmounts the whole app and leaves a blank page, and a lazy screen
 * that failed once stays failed until a reload. Keyed by route, so going elsewhere clears it.
 */
class ScreenBoundary extends Component<{ children: ReactNode; dark?: boolean }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={`screen-wait${this.props.dark ? ' dark' : ''}`}>
        <div className="empty"><strong>This screen did not load</strong>Check that the Mac is awake and on the network, then try again.
          <div className="center"><button className="btn primary" onClick={() => location.reload()}>Try again</button> <button className="btn ghost" onClick={() => back('/')}>Back</button></div>
        </div>
      </div>
    );
  }
}

/** Milliseconds a 429's Retry-After asks for (seconds or an HTTP date), a minute when it says nothing usable. */
function retryAfterMs(header: string | null): number {
  const secs = Number(header);
  const ms = header && Number.isFinite(secs) ? secs * 1000 : header ? Date.parse(header) - Date.now() : NaN;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), 3_600_000) : 60_000;
}

function PinGate() {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [pausedUntil, setPausedUntil] = useState(0);   // too many wrong PINs: the server refuses tries until then
  const field = useRef<HTMLInputElement>(null);
  const paused = pausedUntil > 0;
  useEffect(() => {
    if (!pausedUntil) return;
    const t = window.setTimeout(() => { setPausedUntil(0); setErr(''); }, Math.max(0, pausedUntil - Date.now()));
    return () => window.clearTimeout(t);
  }, [pausedUntil]);
  useEffect(() => { if (!paused) field.current?.focus(); }, [paused]);
  // Its own fetch, not api.auth: the pause length is only in the Retry-After header.
  const submit = async () => {
    if (!pin || paused) return;
    let res: Response;
    try { res = await fetch('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) }); }
    catch { setErr('Could not reach Kino. Is the Mac awake and on the network?'); return; }
    if (res.ok) { location.reload(); return; }
    const said = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
    setErr(typeof said === 'string' && said ? said : res.status === 401 ? 'Wrong PIN' : 'Kino could not check the PIN. Try again.');
    setPin('');
    if (res.status === 429) setPausedUntil(Date.now() + retryAfterMs(res.headers.get('retry-after')));
  };
  return (
    <div className="ob"><div className="ob-card" style={{ maxWidth: 380 }}>
      <h1><Brand /></h1>
      <p className="ob-lead">This Kino asks for a PIN.</p>
      <input ref={field} className="pin" type="password" inputMode="numeric" autoFocus placeholder="PIN" disabled={paused} style={paused ? { opacity: .5 } : undefined} value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      {err ? <p className="err" role="alert" style={{ padding: '8px 0 0' }}>{err}</p> : null}
      <div className="ob-actions"><span className="ob-spacer" /><button className="btn primary" disabled={!pin || paused} onClick={submit}>Unlock</button></div>
    </div></div>
  );
}

/**
 * A screen's wrapper, entering along the way it was reached (push from the right, Back from the left, a tab in place).
 * The kind is read once at mount: a later replace on the same screen must not restart the entrance.
 */
function ScreenIn({ children }: { children: ReactNode }) {
  const [how] = useState(navKind);
  return <div className={`screen-in${how === 'none' ? '' : ` nav-${how}`}`}>{children}</div>;
}

/** True from the first time `open` is, for good: an overlay mounts on first open and stays for its exit animation. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/**
 * Always mounted: a live region only announces what is added after it is already in the page. Notes go in a polite
 * status region, errors in their own alert region; a tap takes a toast away.
 */
function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const of = (kind: 'info' | 'error') => toasts.filter((t) => t.kind === kind).map((t) => <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>{t.text}</div>);
  return (
    <div className="toasts">
      <div className="toast-region" role="status" aria-live="polite">{of('info')}</div>
      <div className="toast-region" role="alert">{of('error')}</div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const settings = useStore((s) => s.settings);
  const locked = useStore((s) => s.locked);
  // Bar space is needed for Kino's own cast AND for someone else's playback on a device.
  const castActive = useStore((s) => s.cast.active || (s.receivers || []).some((r) => r.online && r.media && r.media.state !== 'IDLE'));
  const ccOpen = useStore((s) => s.ccOpen);
  const palOpen = useStore((s) => s.palOpen);
  const ccOpened = useOpenedOnce(ccOpen);
  const palOpened = useOpenedOnce(palOpen);
  useEffect(() => {
    startSse();
    api.castStatus().then((c) => setStore({ cast: c })).catch(() => undefined);
    api.settings().then((s) => setStore({ settings: s })).catch(() => undefined);
    warmScreens();
  }, []);
  useEffect(() => { window.addEventListener('keydown', onPaletteKey); return () => window.removeEventListener('keydown', onPaletteKey); }, []);
  // New screen: scroll to top and drop any overlay that was open (Cast Center is global).
  useEffect(() => { window.scrollTo(0, 0); setStore({ ccOpen: false }); }, [route.path]);
  // Only Home and a title light the page with their artwork; everywhere else the light goes out.
  useEffect(() => { if (route.parts[0] && route.parts[0] !== 'title') setStore({ ambient: null }); }, [route.parts[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  // PWA shortcut "Cast controls" lands on /?cast=1
  useEffect(() => { if (route.query.get('cast') === '1') { setStore({ ccOpen: true, ccOrigin: null }); navigate('/', true); } }, [route.query]);
  const [head] = route.parts;
  let screen: JSX.Element;
  if (head === 'title' && route.parts.length >= 3) screen = <Title key={route.parts.slice(1, 3).join('/')} />;
  else if (head === 'play') screen = <Player key={`${route.query.get('videoId')}|${route.query.get('infoHash')}|${route.query.get('fileIdx')}`} />;
  else if (head === 'settings') screen = <Settings />;
  else if (head === 'magnet') screen = <Magnet />;
  else if (head === 'search') screen = <Search />;
  else if (head === 'browse') screen = <Browse key={route.parts[1] || 'all'} />;
  else if (head === 'library') screen = <Library />;
  else screen = <Home />;
  if (locked) return <PinGate />;
  // First run: walk through sources, subtitles and screens before showing an empty Home.
  if (settings && shouldShowWalkthrough(route, settings)) return <ScreenBoundary><Suspense fallback={<ScreenFallback />}><Onboarding settings={settings} onDone={(s) => { setStore({ settings: s }); navigate('/', true); }} /></Suspense></ScreenBoundary>;
  const inPlayer = head === 'play';
  const inTitle = head === 'title';
  const showDock = !inPlayer && !inTitle;
  return (
    <div className={`app${castActive && !inPlayer ? ' has-bar' : ''}${showDock ? ' has-dock' : ''}`}>
      {!inPlayer ? <Ambient /> : null}
      {inPlayer ? <ScreenBoundary key={route.path} dark><Suspense fallback={<ScreenFallback dark />}>{screen}</Suspense></ScreenBoundary> : <ScreenIn key={route.parts.slice(0, 2).join('/')}><ScreenBoundary key={route.path}><Suspense fallback={<ScreenFallback />}>{screen}</Suspense></ScreenBoundary></ScreenIn>}
      {!inPlayer ? <NowPlayingBar /> : null}
      {!inPlayer ? <CastUpNext /> : null}
      {!inPlayer ? <CastSkipIntro /> : null}
      {!inPlayer ? <CastHotkeys /> : null}
      {showDock ? <Dock /> : null}
      {/* Until their code is here they show nothing, and one that failed to load unmounts so the next open tries again. */}
      {ccOpened && (ccOpen || CastCenter.isReady()) ? <CastCenter /> : null}
      {palOpened && (palOpen || CommandPalette.isReady()) ? <CommandPalette /> : null}
      <EscapeNav />
      <LockRemote />
      <Toasts />
    </div>
  );
}
