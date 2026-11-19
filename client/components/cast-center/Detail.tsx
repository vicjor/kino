import { useRef, useState } from 'react';
import type { ReceiverInfo, CastHistoryEntry } from '../../../server/types.js';
import { api } from '../../lib/api';
import { resumePoint } from '../../lib/progress';
import { useStore, setStore, toast } from '../../lib/store';
import { volumeUnknown } from '../../lib/cast-volume';
import { navigate, titleUrl } from '../../lib/router';
import { handoffHere, sendToTv } from '../../lib/cast-actions';
import { castingEpisode, isMagnetId, metaIdOf } from '../../lib/handoff';
import { langName, skipLabel } from '../../lib/format';
import { isTouch } from '../../lib/player-caps';
import { inIntro } from '../../lib/intro';
import { receiverState, RECEIVER_STATE_LABEL } from '../../lib/receiver-state';
import type { CastKey } from '../../lib/cast-keys';
import { IconLibrary, IconNext, IconPlay, IconPause, IconStop, IconSpeaker, IconTv, IconBack, IconPhone, IconLock, IconBack10, IconFwd10, IconLayers, IconMoon } from '../Icons';
import { toggleLockRemote, lockRemoteSupported } from '../LockRemote';
import { splitShowName } from '../home-data';
import { Hud, Keycap, useHud } from '../Shortcuts';
import { useIntro, useIntroLearner, castIntroQuery } from '../SkipIntro';
import { PowerButton } from './PowerButton';
import { VolumeBar } from './VolumeBar';
import { SeekBar } from './SeekBar';
import { Subtitles } from './Subtitles';
import { History } from './History';
import { useZoomFlip, useSwipeDown } from './motion';
import { useControllerKeys } from './useControllerKeys';
import type { CmdFn, SheetKind } from './shared';

/** Full controller for one device. Zooms out of its tile (FLIP) and back into it. */
export function Detail({ r, from, leaving, sheet, onSheet, onClose, onCmd }: { r: ReceiverInfo; from: DOMRect; leaving: boolean; sheet: SheetKind; onSheet: (s: SheetKind) => void; onClose: () => void; onCmd: CmdFn }) {
  const el = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const cast = useStore((s) => s.cast);
  const lockOn = useStore((s) => s.lockRemote === r.id);
  const m = r.media;
  const Icon = r.audioOnly ? IconSpeaker : IconTv;
  useZoomFlip(el, from, leaving);
  const swipe = useSwipeDown(onClose);

  const run = async (c: 'stop' | 'pause' | 'play') => { setBusy(true); try { await onCmd(r.id, c); } finally { setBusy(false); } };
  const subsAvail = (cast.subs || []).filter((t) => t.available);
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
  const skipH = (d: number, key?: string) => { if (!m || !dur) return; flash(skipLabel(d), key); skip(d); };
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
  useControllerKeys(!!sheet || busy, (a: CastKey) => {
    switch (a.do) {
      case 'play-pause': playPauseH(); return;
      case 'skip': skipH(a.by, a.key); return;
      case 'jump': jumpH(a.tenth); return;
      case 'volume': volH(a.by, a.key); return;
      case 'mute': muteH(); return;
      case 'next': nextH(); return;
      case 'subs': subsH(); return;
      case 'stop-after': stopAfterH(); return;
      case 'intro': if (intro?.end == null || !inIntro(intro, pos)) return false; flash('Skipped the intro', 'I'); introLearn.reset(); void seekTo(intro.end); return;
      case 'source': if (!canSwitch) return false; onSheet('sources'); return;
      case 'here': if (!r.kino) return false; flash('Playing here', 'H'); void playHere(); return;
      case 'stop': if (!r.app) return false; flash('Stopped', 'X'); void run('stop'); return;
      case 'keys': onSheet('keys'); return;
    }
  });
  return (
    <div ref={el} className={`cc-detail${r.app ? ' live' : ''}`} style={swipe.dy ? { transform: `translateY(${swipe.dy}px)`, transition: 'none' } : undefined} {...swipe.handlers}>
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
      <SeekBar r={r} onCmd={onCmd} at={mine ? pos : undefined} dur={mine ? dur : undefined} onSeek={mine ? (t) => { introLearn.onJump(pos, t); void seekTo(t); } : undefined} />
      <div className="cc-transport">
        <button className="cc-skip" disabled={busy || !m || !dur} aria-label="Back 10 seconds" data-hint="Back 10 seconds" data-key="J" onClick={() => skipH(-10, 'J')}><IconBack10 size={28} /></button>
        <button className="cc-play" disabled={busy || !m} aria-label={m?.state === 'PLAYING' ? 'Pause' : 'Play'} data-hint={m?.state === 'PLAYING' ? 'Pause' : 'Play'} data-key="K" onClick={playPauseH}>{m?.state === 'PLAYING' ? <IconPause size={30} /> : <IconPlay size={30} />}</button>
        <button className="cc-skip" disabled={busy || !m || !dur} aria-label="Forward 10 seconds" data-hint="Forward 10 seconds" data-key="L" onClick={() => skipH(10, 'L')}><IconFwd10 size={28} /></button>
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
      <Subtitles show={mine} cast={cast} busy={busy} sub={sub} />
      {lockRemoteSupported && isTouch && r.online ? (
        <button className={`cc-lock${lockOn ? ' on' : ''}`} onClick={() => toggleLockRemote(r.id)}>
          <IconLock /><span>{lockOn ? 'On your lock screen' : 'Show on lock screen'}</span><small>{lockOn ? 'Tap to remove. Pauses other audio on this phone.' : 'Control this device from the lock screen, like Spotify.'}</small>
        </button>
      ) : null}
      <History r={r} busy={busy} onReplay={replay} />
      {!isTouch && m ? (
        <div className="cc-keys" aria-hidden="true">
          <span><Keycap k="Space" /> Play</span>
          <span><Keycap k="←" /><Keycap k="→" /> 10 seconds</span>
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
