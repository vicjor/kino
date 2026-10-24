import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from 'react';
import type { ReceiverInfo, CastHistoryEntry, SubtitleTrack } from '../../server/types.js';
import { api } from '../lib/api';
import { resumePoint } from '../lib/progress';
import { useStore, setStore, toast } from '../lib/store';
import { volumeUnknown } from '../lib/cast-volume';
import { navigate, titleUrl, playUrl } from '../lib/router';
import { handoffHere, sendToTv } from '../lib/cast-actions';
import { castingEpisode, isMagnetId, metaIdOf, nowPlayingParams } from '../lib/handoff';
import { fmtTime, relTime, langName } from '../lib/format';
import { IconLibrary, IconNext, IconPlay, IconPause, IconStop, IconVol, IconMute, IconSpeaker, IconTv, IconX, IconRefresh, IconBack, IconPhone, IconLock, IconBack10, IconFwd10, IconLayers, IconMoon, IconPower } from './Icons';
import { toggleLockRemote, lockRemoteSupported } from './LockRemote';
import { splitShowName } from './home-data';
import { isTouch } from '../lib/player-caps';
import { Hud, Keycap, ShortcutsSheet, CAST_SHORTCUTS, useHud } from './Shortcuts';
import { SourcesSheet } from './SourcesSheet';
import { useIntro, useIntroLearner, castIntroQuery } from './SkipIntro';
import { inIntro } from '../lib/intro';
import { receiverState, RECEIVER_STATE_LABEL } from '../lib/receiver-state';
import { tvsOnly } from '../lib/tvs';
import '../styles/castcenter.css';

export function openCastCenter(): void { setStore({ ccOpen: true, ccOrigin: null }); }

/** Open the Cast Center already zoomed into one device's controller, growing out of `from` (a bar, a widget). */
let pendingDetail: { id: string; from: DOMRect } | null = null;
export function openDeviceController(id: string, from?: DOMRect | null): void {
  const rect = from || new DOMRect(window.innerWidth / 2 - 24, window.innerHeight - 80, 48, 48);
  pendingDetail = { id, from: rect };
  setStore({ ccOpen: true, ccOrigin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
}

const OUT_MS = 280;
const ZOOM_MS = 450;
const ZOOM_OUT_MS = 280;
type Cmd = 'stop' | 'pause' | 'play' | 'volume' | 'seek';
type Body = { level?: number; muted?: boolean; time?: number };
type CmdFn = (id: string, c: Cmd, body?: Body) => Promise<void>;
/** A side sheet over the controller (rendered outside the zooming panel so `position: fixed` still means the viewport). */
type SheetKind = null | 'sources' | 'keys';

/**
 * iOS Control Center style panel: one tile per Cast receiver on the LAN with live
 * state pushed from the server (whoever started the cast). Tap a tile and it
 * zooms into a full controller for that device.
 */
export function CastCenter() {
  const open = useStore((s) => s.ccOpen);
  const origin = useStore((s) => s.ccOrigin);
  const live = useStore((s) => s.receivers);
  const panelRef = useRef<HTMLDivElement>(null);
  const originTf = useRef('');
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const [err, setErr] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [detail, setDetail] = useState<{ id: string; from: DOMRect } | null>(null);
  const [detailLeaving, setDetailLeaving] = useState(false);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const cast = useStore((s) => s.cast);
  // Opened straight into one controller (dock, bar): leaving it closes the whole center, no grid detour.
  const direct = useRef(false);

  useEffect(() => {
    if (open) { setMounted(true); setPhase('in'); direct.current = !!pendingDetail; if (pendingDetail) { setDetail(pendingDetail); pendingDetail = null; } return; }
    if (!mounted) return;
    setPhase('out');
    const node = panelRef.current;
    if (node && originTf.current) { node.style.transition = `transform ${OUT_MS}ms cubic-bezier(.4,0,.6,1), opacity ${OUT_MS}ms ease-in`; node.style.transform = originTf.current; node.style.opacity = '0'; }
    setSheet(null);
    const t = setTimeout(() => { setMounted(false); setDetail(null); setDetailLeaving(false); originTf.current = ''; }, OUT_MS);
    return () => clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opened from a widget: zoom out of its rectangle instead of the generic pop.
  useLayoutEffect(() => {
    const node = panelRef.current;
    if (!mounted || !open || !node || !origin) return;
    const to = node.getBoundingClientRect();
    originTf.current = `translate(${origin.x - to.left}px, ${origin.y - to.top}px) scale(${origin.width / to.width}, ${origin.height / to.height})`;
    node.style.animation = 'none'; node.style.transformOrigin = '0 0'; node.style.transition = 'none';
    node.style.transform = originTf.current; node.style.opacity = '0.5';
    node.getBoundingClientRect();
    node.style.transition = `transform ${ZOOM_MS}ms cubic-bezier(.32,.72,0,1), opacity ${ZOOM_MS * 0.6}ms ease-out`;
    node.style.transform = 'none'; node.style.opacity = '1';
  }, [mounted, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    setSpinning(true);
    api.castReceivers(true).then((r) => { setStore({ receivers: r }); setErr(''); }).catch((e) => setErr(e.message)).finally(() => setTimeout(() => setSpinning(false), 600));
  };
  const closeDetail = () => { if (!detail || detailLeaving) return; setSheet(null); if (direct.current) { setStore({ ccOpen: false }); return; } setDetailLeaving(true); setTimeout(() => { setDetail(null); setDetailLeaving(false); }, ZOOM_OUT_MS); };
  // Rescan once per opening (and from the refresh button), not on every tile tap or sheet toggle.
  useEffect(() => {
    if (!open) return;
    refresh();
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    // A sheet over the controller owns Escape while it is up. Handled here, so a listener after this one (the player
    // behind, which sees the Cast Center already closed) leaves the key alone: playerKeyRoute skips defaultPrevented.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || sheet) return;
      e.preventDefault();
      if (detail) closeDetail(); else setStore({ ccOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, detail, sheet]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null;
  const list = live ? tvsOnly(live) : live;   // TVs only: speakers have no place in a film's controls
  const close = () => setStore({ ccOpen: false });
  const cmd: CmdFn = async (id, c, body) => {
    try {
      const r = await api.castReceiverCmd(id, c, body);
      setStore((s) => ({ receivers: (s.receivers || []).map((x) => (x.id === r.id ? r : x)) }));
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  // Kino's own film on that TV opens the player as its remote; anything else zooms into the device's controller.
  const openTile = (id: string, rect: DOMRect) => {
    const np = cast.deviceId === id ? nowPlayingParams(cast) : null;
    if (np) { setStore({ ccOpen: false }); navigate(playUrl(np)); } else setDetail({ id, from: rect });
  };
  const online = (list || []).filter((r) => r.online).length;
  const playing = (list || []).filter((r) => r.online && r.app).length;
  const detailDevice = detail ? (list || []).find((r) => r.id === detail.id) : undefined;
  // Switch source for Kino's own session on the device in the controller.
  const mine = !!detailDevice && cast.active && cast.deviceId === detailDevice.id;
  const switchTo = async (s: { infoHash: string; fileIdx?: number; provider?: string; addon: string; resolution?: string }) => {
    setSheet(null);
    toast(`Switching to ${s.provider || s.addon}${s.resolution && s.resolution !== 'other' ? ` ${s.resolution}` : ''} on ${detailDevice?.name || 'the TV'}`);
    try { setStore({ cast: await api.castSource(s.infoHash, s.fileIdx) }); } catch (e) { toast((e as Error).message, 'error', 6000); }
  };

  return (
    <>
    <div className={`cc-back ${phase}`} onClick={detail ? closeDetail : close}>
      <div ref={panelRef} className={`cc-panel${detail ? ' has-detail' : ''}${origin ? ' from-origin' : ''}`} role="dialog" aria-modal="true" aria-label="Cast controls" onClick={(e) => e.stopPropagation()}>
        <div className="cc-head">
          <div>
            <h2>Cast</h2>
            <span className="cc-sub">{list ? `${online} online · ${playing} active` : 'Looking around…'}</span>
          </div>
          <button className={`cc-round${spinning ? ' spin' : ''}`} aria-label="Refresh" onClick={refresh}><IconRefresh /></button>
          <button className="cc-round" aria-label="Close" onClick={close}><IconX /></button>
        </div>
        {err ? <div className="err">{err}</div> : null}
        {!list ? <div className="cc-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="cc-tile skeleton" style={{ ['--i' as string]: i }} />)}</div> : null}
        {list && !list.length ? <div className="cc-empty">No TVs on this network yet. Turn on the TV and it shows up here.</div> : null}
        {list ? (
          <div className="cc-grid">
            {list.map((r, i) => <Tile key={r.id} r={r} idx={i} dimmed={!!detail && detail.id !== r.id} onCmd={cmd} onOpen={(rect) => openTile(r.id, rect)} />)}
          </div>
        ) : null}
        <div className="cc-foot">
          <button className="cc-link" disabled={!playing} onClick={() => api.castStopAll().then((r) => setStore({ receivers: r })).catch((e) => toast(e.message, 'error'))}>Stop everything</button>
        </div>
        {detail && detailDevice ? <Detail r={detailDevice} from={detail.from} leaving={detailLeaving} sheet={sheet} onSheet={setSheet} onClose={closeDetail} onCmd={cmd} /> : null}
      </div>
    </div>
    {sheet ? (
      <div className="cc-sheets">
        {sheet === 'keys' ? <ShortcutsSheet title="Controller shortcuts" groups={CAST_SHORTCUTS} onClose={() => setSheet(null)} /> : null}
        {sheet === 'sources' && mine && cast.videoId && !isMagnetId(cast.videoId) ? (
          <SourcesSheet type={cast.type || 'movie'} videoId={cast.videoId} currentId={`${cast.infoHash}:${cast.fileIdx ?? -1}`} target={detailDevice?.kind === 'dlna' ? 'browser' : 'chromecast'}
            title={`Source on ${detailDevice?.name || 'the TV'}`} hint="Pick another release and the TV continues from where it is, same subtitles." onPick={(s) => void switchTo(s)} onClose={() => setSheet(null)} />
        ) : null}
      </div>
    ) : null}
    </>
  );
}

/** Pressable volume bar (iOS style filled track). Shared by tile and detail. */
function VolumeBar({ r, big, onCmd }: { r: ReceiverInfo; big?: boolean; onCmd: CmdFn }) {
  const [vol, setVol] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const lastSend = useRef(0);
  const holdUntil = useRef(0);
  // Hold the locally chosen level briefly so a stale server push cannot yank the bar back.
  const level = vol != null || Date.now() < holdUntil.current ? (vol ?? r.volume) : r.volume;
  const ratio = (e: RPointerEvent) => { const b = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)); };
  const send = (v: number) => { lastSend.current = Date.now(); holdUntil.current = Date.now() + 1500; void onCmd(r.id, 'volume', { level: Math.round(v * 100) / 100 }); };
  const onDown = (e: RPointerEvent) => { if (!r.online) return; e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); setVol(ratio(e)); };
  const onMove = (e: RPointerEvent) => { if (vol == null || !bar.current!.hasPointerCapture(e.pointerId)) return; const v = ratio(e); setVol(v); if (Date.now() - lastSend.current > 140) send(v); };
  const onUp = (e: RPointerEvent) => { if (vol == null) return; bar.current!.releasePointerCapture(e.pointerId); send(vol); setTimeout(() => setVol(null), 1200); };
  return (
    <div ref={bar} className={`cc-vol${vol != null ? ' dragging' : ''}${big ? ' big' : ''}`} role="slider" aria-label={`${r.name} volume`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="cc-vol-fill" style={{ width: `${(r.muted ? 0 : level) * 100}%` }} />
      <button className="cc-vol-ico" aria-label={r.muted ? 'Unmute' : 'Mute'} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void onCmd(r.id, 'volume', { muted: !r.muted }); }}>{r.muted ? <IconMute /> : <IconVol />}</button>
      <span className="cc-vol-pct">{Math.round(level * 100)}</span>
    </div>
  );
}

/** Scrubber with live position; drag to seek (only when the app speaks the media namespace). */
function Scrubber({ r, onCmd, at, dur: durIn, onSeek }: { r: ReceiverInfo; onCmd: CmdFn; at?: number; dur?: number; onSeek?: (t: number) => void }) {
  const [seek, setSeek] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const m = r.media; const dur = durIn ?? m?.duration ?? 0;
  if (!m || !dur) return null;
  const pos = seek != null ? seek * dur : (at ?? m.currentTime ?? 0);
  const ratio = (e: RPointerEvent) => { const b = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)); };
  return (
    <div ref={bar} className={`cc-seek${seek != null ? ' dragging' : ''}`} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pos)}
      onPointerDown={(e) => { e.stopPropagation(); bar.current!.setPointerCapture(e.pointerId); setSeek(ratio(e)); }}
      onPointerMove={(e) => { if (seek == null || !bar.current!.hasPointerCapture(e.pointerId)) return; setSeek(ratio(e)); }}
      onPointerUp={(e) => { if (seek == null) return; bar.current!.releasePointerCapture(e.pointerId); if (onSeek) onSeek(seek * dur); else void onCmd(r.id, 'seek', { time: seek * dur }); setSeek(null); }}
      onPointerCancel={() => setSeek(null)}>
      <i style={{ width: `${(pos / dur) * 100}%` }} />
      <b style={{ left: `${(pos / dur) * 100}%` }} />
      <span className="cc-time">{fmtTime(pos)}</span><span className="cc-time right">-{fmtTime(Math.max(0, dur - pos))}</span>
    </div>
  );
}

/**
 * The TV's power button, playing or not: on over Wake-on-LAN (it keeps waking in the background, the state says so),
 * off over an LG TV's own remote protocol. The first time, the TV asks to allow Kino: a slow answer says so.
 */
function PowerButton({ r }: { r: ReceiverInfo }) {
  const [busy, setBusy] = useState(false);
  const turnOn = !r.online && !!r.canWake;
  const turnOff = r.online && !!r.canPowerOff;
  if (!turnOn && !turnOff) return null;
  const press = async (e: RMouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    const hint = turnOff ? window.setTimeout(() => toast(`Press Allow on ${r.name} to let Kino turn it off`, 'info', 8000), 2500) : 0;
    try {
      const info = await api.castPower(r.id, turnOn);
      if (info) setStore((s) => ({ receivers: (s.receivers || []).map((x) => (x.id === info.id ? info : x)) }));
      else void api.castReceivers().then((list) => setStore({ receivers: list })).catch(() => undefined);
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { window.clearTimeout(hint); setBusy(false); }
  };
  const label = turnOff ? `Turn ${r.name} off` : `Turn ${r.name} on`;
  return <button className={`cc-power${turnOff ? ' on' : ''}${r.waking ? ' waking' : ''}`} aria-label={label} title={label} disabled={busy || !!r.waking} onClick={press}><IconPower /></button>;
}

function Tile({ r, idx, dimmed, onCmd, onOpen }: { r: ReceiverInfo; idx: number; dimmed: boolean; onCmd: CmdFn; onOpen: (rect: DOMRect) => void }) {
  const [busy, setBusy] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const m = r.media;
  const st = receiverState(r);
  const Icon = r.audioOnly ? IconSpeaker : IconTv;
  const run = async (c: 'stop' | 'pause' | 'play') => { setBusy(true); try { await onCmd(r.id, c); } finally { setBusy(false); } };
  const openIt = (e: RMouseEvent) => {
    if ((e.target as HTMLElement).closest('button, [role=slider]')) return;
    if (el.current) onOpen(el.current.getBoundingClientRect());
  };
  return (
    <div ref={el} className={`cc-tile${r.app ? ' live' : ''}${r.online ? '' : ' off'}${dimmed ? ' dim' : ''}`} style={{ ['--i' as string]: idx }} onClick={openIt} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && el.current) onOpen(el.current.getBoundingClientRect()); }}>
      <div className="cc-tile-head">
        <span className="cc-ico"><Icon /></span>
        <span className="cc-name">{r.name}<span className={`cc-state ${st}`}><i />{RECEIVER_STATE_LABEL[st]}</span></span>
        <PowerButton r={r} />
      </div>
      <div className="cc-now">
        {m?.artwork ? <img className="cc-art" src={m.artwork} alt="" /> : null}
        <div className="cc-now-text">
          {r.app ? (
            <>
              <strong>{m?.title || r.app.name}</strong>
              <span>{[r.kino ? 'Kino' : m?.title ? r.app.name : null, m?.subtitle].filter(Boolean).join(' · ') || r.model}</span>
            </>
          ) : <span>{r.online ? r.model : r.asleep ? (r.canWake ? 'Off. Turn it on here, or cast to it' : 'Off. Turn it on with the remote once so Kino can wake it') : 'Not reachable right now'}</span>}
        </div>
      </div>
      {volumeUnknown(r) ? null : <VolumeBar r={r} onCmd={onCmd} />}
      <div className="cc-actions">
        <button className="cc-btn" disabled={busy || !m} aria-label={m?.state === 'PLAYING' ? 'Pause' : 'Play'} onClick={() => run(m?.state === 'PLAYING' ? 'pause' : 'play')}>{m?.state === 'PLAYING' ? <IconPause /> : <IconPlay />}</button>
        <button className="cc-btn stop" disabled={busy || !r.app} aria-label="Stop" onClick={() => run('stop')}><IconStop /></button>
      </div>
    </div>
  );
}

/** Full controller for one device. Zooms out of its tile (FLIP) and back into it. */
function Detail({ r, from, leaving, sheet, onSheet, onClose, onCmd }: { r: ReceiverInfo; from: DOMRect; leaving: boolean; sheet: SheetKind; onSheet: (s: SheetKind) => void; onClose: () => void; onCmd: CmdFn }) {
  const el = useRef<HTMLDivElement>(null);
  const origin = useRef('');
  const [history, setHistory] = useState<CastHistoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const cast = useStore((s) => s.cast);
  const lockOn = useStore((s) => s.lockRemote === r.id);
  const drag = useRef<{ y: number; id: number } | null>(null);
  const [dy, setDy] = useState(0);
  const m = r.media;
  const Icon = r.audioOnly ? IconSpeaker : IconTv;

  // FLIP: start at the tile's rectangle, settle into the panel. Reverse on leave.
  // The detail is absolute inside the scrollable panel, so it sits at the scroll
  // origin: bring the panel back to the top first or a scrolled phone never sees it.
  const prevScroll = useRef(0);
  useLayoutEffect(() => {
    const node = el.current; if (!node) return;
    const panel = node.parentElement;
    if (panel) { prevScroll.current = panel.scrollTop; panel.scrollTop = 0; }
    const to = node.getBoundingClientRect();
    const sx = from.width / to.width, sy = from.height / to.height;
    origin.current = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
    node.style.transition = 'none';
    node.style.transform = origin.current;
    node.style.opacity = '0.6';
    node.getBoundingClientRect(); // flush
    node.style.transition = `transform ${ZOOM_MS}ms cubic-bezier(.32,.72,0,1), opacity ${ZOOM_MS * 0.6}ms ease-out`;
    node.style.transform = 'none';
    node.style.opacity = '1';
  }, [from]);
  useEffect(() => {
    const node = el.current; if (!node || !leaving) return;
    // Put the list back where it was so the zoom-out lands on the tile that was tapped.
    if (node.parentElement) node.parentElement.scrollTop = prevScroll.current;
    node.style.transition = `transform ${ZOOM_OUT_MS}ms cubic-bezier(.4,0,.6,1), opacity ${ZOOM_OUT_MS}ms ease-in`;
    node.style.transform = origin.current;
    node.style.opacity = '0';
  }, [leaving]);
  useEffect(() => { api.castHistory(r.id).then(setHistory).catch(() => setHistory([])); }, [r.id, m?.title]);

  const run = async (c: 'stop' | 'pause' | 'play') => { setBusy(true); try { await onCmd(r.id, c); } finally { setBusy(false); } };
  const [allSubs, setAllSubs] = useState(false);
  const subsAvail = (cast.subs || []).filter((t) => t.available);
  // Several tracks per language is normal: keep the language, number the rest, star the hash match.
  const subLabel = (t: SubtitleTrack) => { const same = subsAvail.filter((x) => x.lang === t.lang); const n = same.indexOf(t) + 1; return `${langName(t.lang)}${same.length > 1 ? ` ${n}` : ''}${t.hashMatch ? ' ★' : ''}`; };
  // The kind comes from the cast status, never from the id's shape.
  const isSeries = !!castingEpisode(cast);
  const nextEp = async () => { setBusy(true); try { setStore({ cast: await api.castNext() }); toast('Next episode on its way'); } catch (e) { toast((e as Error).message, 'error', 5000); } finally { setBusy(false); } };
  const sub = async (id: string | null, offsetMs?: number) => { setBusy(true); try { setStore({ cast: await api.castSubtitle(id, offsetMs) }); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } };
  // "Stop after this episode": the credits roll and nothing follows. Same switch the up-next popup's "Not now" flips.
  const toggleStopAfter = async () => { setBusy(true); try { setStore({ cast: await api.castUpNext(!cast.stopAfter) }); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } };
  const playHere = async () => {
    setBusy(true);
    try { if (await handoffHere(cast)) setStore({ ccOpen: false }); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  // sendToTv arms the lock-screen remote inside the tap; the resume point is looked up after that.
  const replay = async (k: NonNullable<CastHistoryEntry['kino']>) => {
    setBusy(true);
    try {
      await sendToTv(r, async (deviceId) => {
        const prog = k.videoId ? await api.progress(k.videoId).catch(() => null) : null;
        await api.castPlay({ deviceId, infoHash: k.infoHash, fileIdx: k.fileIdx, videoId: k.videoId, title: k.title, poster: k.poster, startTime: resumePoint(prog) ?? 0 });
      }, `Casting ${k.title} to ${r.name}`);
    } finally { setBusy(false); }
  };
  // Swipe down anywhere on the header/art to dismiss
  const onDown = (e: RPointerEvent) => { if ((e.target as HTMLElement).closest('button, [role=slider], .cc-hist')) return; drag.current = { y: e.clientY, id: e.pointerId }; };
  const onMove = (e: RPointerEvent) => { if (drag.current?.id === e.pointerId) setDy(Math.max(0, e.clientY - drag.current.y)); };
  const onUp = (e: RPointerEvent) => { if (drag.current?.id !== e.pointerId) return; const d = e.clientY - drag.current.y; drag.current = null; setDy(0); if (d > 90) onClose(); };

  const art = m?.artwork || (r.kino ? cast.poster : undefined);
  const st = receiverState(r);
  // Kino's own cast: the receiver reports HLS-session time, so use the absolute position and duration the server keeps.
  const mine = !!r.kino && cast.active && cast.deviceId === r.id;
  const pos = mine ? cast.currentTime || 0 : m?.currentTime || 0;
  const dur = mine ? cast.duration || 0 : m?.duration || 0;
  const seekTo = (t: number) => { const x = Math.max(0, Math.min(dur ? dur - 1 : t, t)); return mine ? api.castSeek(x).catch((e) => toast((e as Error).message, 'error')) : onCmd(r.id, 'seek', { time: x }); };
  // Skipping the titles by hand here teaches Kino, same as in the player.
  const introQ = mine ? castIntroQuery(cast) : null;
  const introLearn = useIntroLearner(introQ);
  const intro = useIntro(introQ);
  const skip = (d: number) => { if (!m || !dur) return; introLearn.onJump(pos, pos + d); void seekTo(pos + d); };
  const titleParts = mine && cast.title ? splitShowName(cast.title) : { show: m?.title || r.app?.name || (r.online ? 'Nothing playing' : 'Offline'), episode: '' };
  const canSwitch = mine && !!cast.videoId && !isMagnetId(cast.videoId);
  const modeLabel = mine && cast.mode ? (cast.mode === 'direct' ? 'Direct play' : cast.mode === 'hls-copy' ? 'Remuxed' : 'Transcoding on the Mac') : null;

  // ---- keyboard: the player's keys, aimed at the TV. Every action flashes what it did and which key does it. ----
  const { hud, flash } = useHud();
  const playPauseH = () => { if (!m) return; flash(m.state === 'PLAYING' ? 'Pause' : 'Play', 'K'); void run(m.state === 'PLAYING' ? 'pause' : 'play'); };
  const skipH = (d: number, key?: string) => { if (!m || !dur) return; flash(`${d > 0 ? '+' : '−'}${Math.abs(d) >= 60 ? `${Math.abs(d) / 60} min` : `${Math.abs(d)} s`}`, key); skip(d); };
  const volH = (d: number, key?: string) => { if (!r.online || volumeUnknown(r)) return; const v = Math.round(Math.min(1, Math.max(0, r.volume + d)) * 20) / 20; flash(`Volume ${Math.round(v * 100)}%`, key); void onCmd(r.id, 'volume', { level: v, muted: false }); };
  const muteH = () => { if (volumeUnknown(r)) return; flash(r.muted ? 'Sound on' : 'Muted', 'M'); void onCmd(r.id, 'volume', { muted: !r.muted }); };
  const jumpH = (tenth: number) => { if (!dur) return; flash(tenth ? `${tenth * 10}%` : 'Start', String(tenth)); void seekTo(dur * tenth / 10); };
  const nextH = () => { if (mine && isSeries) { flash('Next episode', 'N'); void nextEp(); } else flash('No next episode', 'N'); };
  const subsH = () => {
    if (!mine) return;
    if (cast.activeSubId) { flash('Subtitles off', 'V'); void sub(null); return; }
    const t = subsAvail.find((x) => x.recommended) || subsAvail[0];
    if (t) { flash(`Subtitles: ${langName(t.lang)}`, 'V'); void sub(t.id); } else flash('No subtitles', 'V');
  };
  const stopAfterH = () => { if (!mine || !isSeries) return; flash(cast.stopAfter ? 'Auto-next on' : 'Stopping after this episode', 'E'); void toggleStopAfter(); };
  useEffect(() => {
    if (isTouch) return;
    const onKey = (e: KeyboardEvent) => {
      if (sheet || busy || (e.target as HTMLElement).tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key; const stop = () => e.preventDefault();
      if (k === ' ' || k === 'k' || k === 'K') { playPauseH(); stop(); }
      else if (k === 'ArrowLeft') { skipH(e.shiftKey ? -60 : -10, e.shiftKey ? '⇧ ←' : '←'); stop(); }
      else if (k === 'ArrowRight') { skipH(e.shiftKey ? 60 : 10, e.shiftKey ? '⇧ →' : '→'); stop(); }
      else if (k === 'j' || k === 'J') { skipH(-10, 'J'); stop(); }
      else if (k === 'l' || k === 'L') { skipH(10, 'L'); stop(); }
      else if (/^[0-9]$/.test(k)) { jumpH(Number(k)); stop(); }
      else if (k === 'ArrowUp') { volH(0.05, '↑'); stop(); }
      else if (k === 'ArrowDown') { volH(-0.05, '↓'); stop(); }
      else if (k === 'm' || k === 'M') { muteH(); stop(); }
      else if (k === 'n' || k === 'N') { nextH(); stop(); }
      else if (k === 'v' || k === 'V') { subsH(); stop(); }
      else if (k === 'e' || k === 'E') { stopAfterH(); stop(); }
      else if ((k === 'i' || k === 'I') && intro?.end != null && inIntro(intro, pos)) { flash('Skipped the intro', 'I'); introLearn.reset(); void seekTo(intro.end); stop(); }
      else if ((k === 's' || k === 'S') && canSwitch) { onSheet('sources'); stop(); }
      else if ((k === 'h' || k === 'H') && r.kino) { flash('Playing here', 'H'); void playHere(); stop(); }
      else if ((k === 'x' || k === 'X') && r.app) { flash('Stopped', 'X'); void run('stop'); stop(); }
      else if (k === '?') { onSheet('keys'); stop(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // every render: the handlers close over live state and are cheap to rebind
  return (
    <div ref={el} className={`cc-detail${r.app ? ' live' : ''}`} style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {art ? <div className="cc-detail-bg" style={{ backgroundImage: `url(${art})` }} aria-hidden="true" /> : null}
      <div className="cc-detail-head">
        <button className="cc-round" aria-label="Back" data-hint="Back" data-key="Esc" onClick={onClose}><IconBack /></button>
        <div className="cc-detail-title"><strong>{r.name}</strong><span className={`cc-state ${st}`}><i />{RECEIVER_STATE_LABEL[st]}{r.app && !m?.title ? ` · ${r.app.name}` : ''}</span></div>
        {!isTouch ? <button className="cc-round cc-keys-btn" aria-label="Keyboard shortcuts" data-hint="Shortcuts" data-key="?" onClick={() => onSheet('keys')}><span className="keys-glyph">?</span></button> : null}
        <PowerButton r={r} />
        <span className="cc-ico big"><Icon /></span>
      </div>
      <div className="cc-hero">
        {art ? <img className="cc-hero-art" src={art} alt="" /> : <div className="cc-hero-glyph"><Icon /></div>}
        <div className="cc-hero-text">
          <strong>{titleParts.show}</strong>
          <span>{[titleParts.episode, r.kino ? 'Kino' : m?.title ? r.app?.name : null, !mine ? m?.subtitle : null, modeLabel].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      <Scrubber r={r} onCmd={onCmd} at={mine ? pos : undefined} dur={mine ? dur : undefined} onSeek={mine ? (t) => { introLearn.onJump(pos, t); void seekTo(t); } : undefined} />
      <div className="cc-transport">
        <button className="cc-skip" disabled={busy || !m || !dur} aria-label="Back 10 seconds" data-hint="Back 10 s" data-key="J" onClick={() => skipH(-10, 'J')}><IconBack10 size={28} /></button>
        <button className="cc-play" disabled={busy || !m} aria-label={m?.state === 'PLAYING' ? 'Pause' : 'Play'} data-hint={m?.state === 'PLAYING' ? 'Pause' : 'Play'} data-key="K" onClick={playPauseH}>{m?.state === 'PLAYING' ? <IconPause size={30} /> : <IconPlay size={30} />}</button>
        <button className="cc-skip" disabled={busy || !m || !dur} aria-label="Forward 10 seconds" data-hint="Forward 10 s" data-key="L" onClick={() => skipH(10, 'L')}><IconFwd10 size={28} /></button>
      </div>
      {volumeUnknown(r) ? null : <VolumeBar r={r} onCmd={onCmd} />}
      <div className="cc-actions">
        <button className="cc-btn stop" disabled={busy || !r.app} data-hint="Stop casting" data-key="X" onClick={() => run('stop')}><IconStop /> Stop</button>
        {canSwitch ? <button className="cc-btn" disabled={busy} data-hint="Switch source" data-key="S" onClick={() => onSheet('sources')}><IconLayers /> Source</button> : null}
        {r.kino ? <button className="cc-btn" disabled={busy} data-hint="Play here instead" data-key="H" onClick={playHere}><IconPhone /> Play here</button> : null}
      </div>
      {/* A magnet file has no title page, and never a next episode. */}
      {mine && cast.videoId && !isMagnetId(cast.videoId) ? (
        <div className="cc-actions">
          {isSeries ? <button className="cc-btn" disabled={busy} data-hint="Next episode" data-key="N" onClick={nextEp}><IconNext /> Next episode</button> : null}
          <button className="cc-btn" onClick={() => { setStore({ ccOpen: false }); navigate(titleUrl(isSeries ? 'series' : 'movie', metaIdOf(cast.videoId!), cast.videoId)); }}><IconLibrary /> {isSeries ? 'All episodes' : 'Details'}</button>
        </div>
      ) : null}
      {mine && isSeries ? (
        <button className={`cc-lock${cast.stopAfter ? ' on' : ''}`} disabled={busy} data-hint="Stop after this episode" data-key="E" onClick={toggleStopAfter}>
          <IconMoon /><span>{cast.stopAfter ? 'Stopping after this episode' : 'Stop after this episode'}</span><small>{cast.stopAfter ? 'The credits roll and the TV goes quiet. Tap to keep going.' : 'Good for bedtime: no next episode when this one ends.'}</small>
        </button>
      ) : null}
      {mine && cast.subs?.length ? (
        <div className="cc-subs">
          <h3>Subtitles</h3>
          <div className="cc-subs-list">
            <button className={`cc-chip${!cast.activeSubId ? ' on' : ''}`} disabled={busy} onClick={() => sub(null)}>Off</button>
            {(allSubs ? subsAvail : subsAvail.slice(0, 11)).map((t) => (
              <button key={t.id} className={`cc-chip${cast.activeSubId === t.id ? ' on' : ''}`} disabled={busy} title={t.label} onClick={() => sub(t.id)}>{subLabel(t)}</button>
            ))}
            {!allSubs && subsAvail.length > 11 ? <button className="cc-chip more" onClick={() => setAllSubs(true)}>{subsAvail.length - 11} more</button> : null}
          </div>
          {cast.activeSubId ? (
            <div className="cc-sync">
              <span>Sync</span>
              <button className="cc-mini" disabled={busy} aria-label="Subtitles 0.1 s earlier" onClick={() => sub(cast.activeSubId || null, (cast.subOffsetMs || 0) - 100)}>−</button>
              <b>{((cast.subOffsetMs || 0) / 1000).toFixed(1)} s</b>
              <button className="cc-mini" disabled={busy} aria-label="Subtitles 0.1 s later" onClick={() => sub(cast.activeSubId || null, (cast.subOffsetMs || 0) + 100)}>+</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {lockRemoteSupported && isTouch && r.online ? (
        <button className={`cc-lock${lockOn ? ' on' : ''}`} onClick={() => toggleLockRemote(r.id)}>
          <IconLock /><span>{lockOn ? 'On your lock screen' : 'Show on lock screen'}</span><small>{lockOn ? 'Tap to remove. Pauses other audio on this phone.' : 'Control this device from the lock screen, like Spotify.'}</small>
        </button>
      ) : null}
      <div className="cc-hist">
        <h3>Recently played here</h3>
        {history === null ? <div className="cc-hist-empty">…</div> : null}
        {history && !history.length ? <div className="cc-hist-empty">Nothing yet. Kino remembers what plays on this device from now on.</div> : null}
        {(history || []).slice(0, 12).map((h, i) => (
          <div key={h.ts + ':' + i} className="cc-hist-row">
            {h.artwork || h.kino?.poster ? <img src={h.kino?.poster || h.artwork} alt="" /> : <span className="cc-hist-dot" />}
            <div className="cc-hist-text"><strong>{h.kino?.title || h.title}</strong><span>{[h.app, h.subtitle, relTime(h.ts)].filter(Boolean).join(' · ')}</span></div>
            {h.kino ? <button className="cc-mini" disabled={busy} aria-label="Play again here" onClick={() => replay(h.kino!)}><IconPlay /></button> : null}
          </div>
        ))}
      </div>
      {!isTouch && m ? (
        <div className="cc-keys" aria-hidden="true">
          <span><Keycap k="Space" /> Play</span>
          <span><Keycap k="←" /><Keycap k="→" /> 10 s</span>
          <span><Keycap k="↑" /><Keycap k="↓" /> Volume</span>
          {mine && isSeries ? <span><Keycap k="N" /> Next</span> : null}
          {canSwitch ? <span><Keycap k="S" /> Source</span> : null}
          <button className="cc-keys-all" onClick={() => onSheet('keys')}><Keycap k="?" /> All shortcuts</button>
        </div>
      ) : null}
      <Hud hud={hud} />
    </div>
  );
}
