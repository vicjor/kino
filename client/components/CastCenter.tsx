import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore, setStore, toast } from '../lib/store';
import { navigate, playUrl } from '../lib/router';
import { isMagnetId, nowPlayingParams } from '../lib/handoff';
import { IconX, IconRefresh } from './Icons';
import { ShortcutsSheet, CAST_SHORTCUTS } from './Shortcuts';
import { SourcesSheet } from './SourcesSheet';
import { tvsOnly } from '../lib/tvs';
import { DeviceGrid } from './cast-center/DeviceGrid';
import { Detail } from './cast-center/Detail';
import { ZOOM_MS, ZOOM_OUT_MS, type CmdFn, type SheetKind } from './cast-center/shared';
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
        <DeviceGrid list={list} openId={detail ? detail.id : null} onCmd={cmd} onOpen={openTile} />
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
