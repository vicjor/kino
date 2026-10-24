import { useEffect, useState, type ReactNode } from 'react';
import { useStore, setStore, toast, type AppState } from '../lib/store';
import type { ReceiverInfo } from '../../server/types.js';
import { api } from '../lib/api';
import { handoffHere } from '../lib/cast-actions';
import { fmtTime } from '../lib/format';
import { IconPlay, IconPause, IconStop, IconPhone, IconSubs, IconVol, IconMute, IconTv, IconSpeaker, IconLock } from './Icons';
import { toggleLockRemote, lockRemoteSupported } from './LockRemote';
import { isTouch } from '../lib/player-caps';
import { SubtitleMenu } from './SubtitleMenu';
import { openDeviceController } from '../lib/overlays';
import { navigate, playUrl } from '../lib/router';
import { nowPlayingParams } from '../lib/handoff';
import type { CastStatus } from '../../server/types.js';
import { tvVolume, setTvVolume, type VolumeChange } from '../lib/cast-volume';
import '../styles/nowplaying.css';

/**
 * Keeps `--npbar-h` on <html> at the shown bar's height, so the page padding, the toasts and the up-next card clear a
 * title that wraps (global.css, dock.css, upnext.css). One observer: React detaches the old bar's ref before it
 * attaches the new one.
 */
let barObserver: ResizeObserver | null = null;
function trackBarHeight(el: HTMLDivElement | null) {
  barObserver?.disconnect(); barObserver = null;
  const root = document.documentElement.style;
  if (!el) { root.removeProperty('--npbar-h'); return; }
  const set = () => root.setProperty('--npbar-h', `${el.offsetHeight}px`);
  set();
  if (typeof ResizeObserver === 'undefined') return;
  barObserver = new ResizeObserver(set);
  barObserver.observe(el, { box: 'border-box' });
}

/**
 * Kino's own film or episode on a TV opens the player as its remote, the mini player growing into the full one as on
 * iOS. Something another app plays opens that device's controller in the Cast Center.
 */
function expand(deviceId: string, from: DOMRect | undefined, cast?: CastStatus) {
  const np = cast ? nowPlayingParams(cast) : null;
  if (np) navigate(playUrl(np));
  else openDeviceController(deviceId, from);
}

/** Tap the bar (not its buttons or sliders) to open the big controller for the device it shows. */
function openFrom(e: React.MouseEvent<HTMLElement>, deviceId?: string | null, cast?: CastStatus) {
  if (!deviceId || (e.target as HTMLElement).closest('button, input, [role=slider]')) return;
  expand(deviceId, e.currentTarget.getBoundingClientRect(), cast);
}

/**
 * The title block is the bar's one real button (keyboard, screen readers): it opens the same controller, zooming
 * out of the whole bar. A tap anywhere else on the bar still does too, through `openFrom`.
 */
function TitleButton({ deviceId, cast, children }: { deviceId?: string | null; cast?: CastStatus; children: ReactNode }) {
  return (
    <button type="button" className="np-text" aria-haspopup="dialog"
      onClick={(e) => { if (deviceId) expand(deviceId, e.currentTarget.closest('.npbar')?.getBoundingClientRect(), cast); }}>
      {children}
    </button>
  );
}

/** Another app's film or video on a TV, shown in the bar while Kino itself casts nothing. */
const foreignOf = (s: AppState): ReceiverInfo | null => (s.cast.active ? null : (s.receivers || []).find((r) => r.online && !r.audioOnly && r.media && (r.media.state === 'PLAYING' || r.media.state === 'PAUSED' || r.media.state === 'BUFFERING')) || null);
/** The bar is up. The phone tab bar takes it into its own row then (Dock.tsx). */
export const barShown = (s: AppState): boolean => s.cast.active || !!foreignOf(s);

export function NowPlayingBar() {
  const cast = useStore((s) => s.cast);
  const [seek, setSeek] = useState<number | null>(null);
  const [subsOpen, setSubsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const [volDrag, setVolDrag] = useState<number | null>(null);
  const receivers = useStore((s) => s.receivers);
  const lockOn = useStore((s) => !!s.cast.deviceId && s.lockRemote === s.cast.deviceId);
  const foreign = useStore(foreignOf);
  useEffect(() => { if (!cast.active) setSubsOpen(false); }, [cast.active]);
  if (!cast.active) return foreign ? <ForeignBar r={foreign} /> : null;
  const dur = cast.duration || 0;
  const cur = seek ?? cast.currentTime ?? 0;
  const tv = tvVolume(cast, receivers);
  const { level, muted } = tv;
  const setVolume = (b: VolumeChange) => setTvVolume(tv, b);
  const run = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } };
  const handoff = () => run(() => handoffHere(cast));
  return (
    <>
      <div className="npbar" ref={trackBarHeight} onClick={(e) => openFrom(e, cast.deviceId, cast)}>
        <div className="np-top">
          {cast.poster ? <img src={cast.poster} alt="" /> : null}
          <TitleButton deviceId={cast.deviceId} cast={cast}>
            <span className="np-title">{cast.title || 'Casting'}</span>
            <span className="np-sub">{cast.deviceName}{cast.state === 'BUFFERING' ? ' · buffering' : ''}{cast.error ? ` · ${cast.error}` : ''}</span>
          </TitleButton>
          {/* Transport first, then the secondary controls; volume last because its slider opens under it */}
          <button className="iconbtn" aria-label={cast.state === 'PLAYING' ? 'Pause' : 'Play'} data-hint={cast.state === 'PLAYING' ? 'Pause' : 'Play'} data-key="Space" disabled={busy} onClick={() => run(() => (cast.state === 'PLAYING' ? api.castPause() : api.castResume()))}>{cast.state === 'PLAYING' ? <IconPause /> : <IconPlay />}</button>
          <button className="iconbtn np-stop" aria-label="Stop casting" data-hint="Stop casting" data-key="X" disabled={busy} onClick={() => run(() => api.castStop())}><IconStop /></button>
          {/* Phone hides these: the mini bar keeps transport only, everything else lives in the big controller a tap away */}
          <span className="np-more">
            <span className="np-sep" aria-hidden="true" />
            <button className="iconbtn" aria-label="Subtitles" onClick={() => setSubsOpen(true)}><IconSubs /></button>
            {lockRemoteSupported && isTouch ? <button className={`iconbtn${lockOn ? ' on' : ''}`} aria-label="Lock screen remote" aria-pressed={lockOn} onClick={() => cast.deviceId && toggleLockRemote(cast.deviceId)}><IconLock /></button> : null}
            {tv.unknown ? null : <button className="iconbtn" aria-label="Volume" aria-expanded={volOpen} onClick={() => setVolOpen((v) => !v)}>{muted || level === 0 ? <IconMute /> : <IconVol />}</button>}
          </span>
        </div>
        {dur ? <div className="np-prog" aria-hidden="true"><i style={{ width: `${Math.min(100, (cur / dur) * 100)}%` }} /></div> : null}
        {volOpen && !tv.unknown ? (
          <div className="np-vol">
            <button className="iconbtn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => run(() => setVolume({ muted: !muted }))}>{muted ? <IconMute /> : <IconVol />}</button>
            <input type="range" min={0} max={100} step={1} value={Math.round((volDrag ?? (muted ? 0 : level)) * 100)} aria-label="Volume"
              onChange={(e) => { const v = Number(e.target.value) / 100; setVolDrag(v); }}
              onPointerUp={() => { if (volDrag != null) { run(() => setVolume({ level: volDrag })); setTimeout(() => setVolDrag(null), 1200); } }}
              onKeyUp={() => { if (volDrag != null) { run(() => setVolume({ level: volDrag })); setTimeout(() => setVolDrag(null), 1200); } }} />
            <span className="np-volpct">{Math.round((volDrag ?? (muted ? 0 : level)) * 100)}</span>
          </div>
        ) : null}
        <div className="np-seek">
          <span>{fmtTime(cur)}</span>
          <input type="range" min={0} max={dur || 1} step={1} value={cur} disabled={!dur}
            onChange={(e) => setSeek(Number(e.target.value))}
            onPointerUp={() => { if (seek != null) { run(() => api.castSeek(seek)); setSeek(null); } }}
            onKeyUp={() => { if (seek != null) { run(() => api.castSeek(seek)); setSeek(null); } }} />
          <span>{fmtTime(dur)}</span>
          <button className="btn small ghost" onClick={handoff} disabled={busy}><IconPhone /> Continue here</button>
        </div>
      </div>
      {subsOpen ? (
        <SubtitleMenu title="Subtitles on TV" tracks={cast.subs || []} active={cast.activeSubId} offsetMs={cast.subOffsetMs || 0} loading={false} applying={busy}
          onPick={(t) => run(() => api.castSubtitle(t ? t.id : null))} onOffset={(ms) => run(() => api.castSubtitle(cast.activeSubId || null, ms))} onClose={() => setSubsOpen(false)} />
      ) : null}
    </>
  );
}

/** Something else is playing on a Cast device (YouTube on the TV, Spotify on a
 *  speaker): the bar still shows it, with pause/stop, and opens the Cast Center. */
function ForeignBar({ r }: { r: ReceiverInfo }) {
  const [busy, setBusy] = useState(false);
  const m = r.media!;
  const cmd = async (c: 'play' | 'pause' | 'stop') => {
    setBusy(true);
    try { const u = await api.castReceiverCmd(r.id, c); setStore((s) => ({ receivers: (s.receivers || []).map((x) => (x.id === u.id ? u : x)) })); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const Icon = r.audioOnly ? IconSpeaker : IconTv;
  const playing = m.state === 'PLAYING';
  return (
    <div className="npbar foreign" ref={trackBarHeight} onClick={(e) => openFrom(e, r.id)}>
      <div className="np-top">
        {m.artwork ? <img src={m.artwork} alt="" /> : <span className="np-glyph"><Icon /></span>}
        <TitleButton deviceId={r.id}>
          <span className="np-title">{m.title || r.app?.name || 'Playing'}</span>
          <span className="np-sub">{r.name}{m.title && r.app ? ` · ${r.app.name}` : ''}{m.duration ? ` · ${fmtTime(m.currentTime)} / ${fmtTime(m.duration)}` : ''}</span>
        </TitleButton>
        <button className="iconbtn" aria-label={playing ? 'Pause' : 'Play'} disabled={busy} onClick={(e) => { e.stopPropagation(); void cmd(playing ? 'pause' : 'play'); }}>{playing ? <IconPause /> : <IconPlay />}</button>
        <button className="iconbtn np-stop" aria-label="Stop" disabled={busy} onClick={(e) => { e.stopPropagation(); void cmd('stop'); }}><IconStop /></button>
      </div>
      {m.duration ? <div className="np-prog" aria-hidden="true"><i style={{ width: `${Math.min(100, (m.currentTime / m.duration) * 100)}%` }} /></div> : null}
    </div>
  );
}
