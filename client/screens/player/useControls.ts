import { useCallback, useEffect, useRef, useState, type Dispatch, type MouseEvent as RMouseEvent, type RefObject, type SetStateAction } from 'react';
import type { Episode, IntroEstimate, SubtitleTrack } from '../../../server/types.js';
import { getStore } from '../../lib/store';
import { isIOS, isTouch } from '../../lib/player-caps';
import { skipLabel, offsetLabel } from '../../lib/format';
import { playerKeyRoute, type PlayerSheets } from '../../lib/player-keys';
import { doubleTapSkip, speedStep, speedWords } from '../../lib/playback';
import { onPlayerChrome } from '../../components/Controls';
import type { ShowNotice } from './PlayerChrome';

const LS_VOL = 'kino.volume';

/** The player's own volume (remembered per browser) and mute (per play). */
export function useVolume() {
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(LS_VOL) ?? 1));
  const [muted, setMuted] = useState(false);
  const setVol = (x: number) => { setVolume(x); setMuted(false); localStorage.setItem(LS_VOL, String(x)); };
  const toggleMute = () => setMuted((m) => !m);
  return { volume, muted, setVol, toggleMute };
}

type Video = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitShowPlaybackTargetPicker?: () => void; webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string };

function fullscreen(v: Video | null, w: HTMLDivElement | null) {
  if (isIOS && v?.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  else { w?.requestFullscreen?.().then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined)).catch(() => undefined); }
}
function pip(v: Video | null) {
  if (!v) return;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => undefined);
  else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => undefined);
  else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
}

interface ControlsArgs {
  videoRef: RefObject<HTMLVideoElement | null>;
  wrapRef: RefObject<HTMLDivElement | null>;
  flash: (text: string, key?: string) => void;
  showNotice: ShowNotice;
  playing: boolean;
  togglePlay: () => void;
  skip: (d: number) => Promise<void>;
  seekTo: (t: number) => Promise<void>;
  absTime: () => number;
  totalDur: () => number;
  introLearn: { onJump: (from: number, to: number) => void; reset: () => void };
  intro: IntroEstimate | null;
  showIntro: boolean;
  volume: number;
  muted: boolean;
  setVol: (x: number) => void;
  toggleMute: () => void;
  subs: SubtitleTrack[];
  activeSub: SubtitleTrack | null;
  toggleSubs: () => void;
  setSubOffset: Dispatch<SetStateAction<number>>;
  next: Episode | null;
  playNext: () => Promise<void>;
  sheetOpen: boolean;
  sheetsRef: RefObject<PlayerSheets>;
  setKeysOpen: (b: boolean) => void;
  openSubs: () => void;
  openDest: () => void;
  openSources?: () => void;
  openAudio?: () => void;
  leave: () => void;
}

/**
 * Everything you do to the player by hand: the controls showing and hiding, taps and clicks on the picture,
 * fullscreen, picture in picture, AirPlay, volume, speed, and the keyboard. Every action says what it did and which
 * key does it (the HUD).
 */
export function usePlayerControls(a: ControlsArgs) {
  const { videoRef, wrapRef, flash, showNotice, playing, togglePlay, skip, seekTo, absTime, totalDur, introLearn, intro, showIntro, volume, muted, setVol, toggleMute, subs, activeSub, toggleSubs, setSubOffset, next, playNext, sheetOpen, sheetsRef, setKeysOpen, openSubs, openDest, openSources, openAudio, leave } = a;
  const hideTimer = useRef<number | null>(null);
  const lastTap = useRef<{ t: number; x: number }>({ t: 0, x: 0 });
  const [showCtl, setShowCtl] = useState(true);

  const playPause = useCallback(() => { const v = videoRef.current; flash(v?.paused ? 'Play' : 'Pause', 'K'); togglePlay(); }, [flash, togglePlay, videoRef]);
  const skipH = (d: number, key?: string) => { introLearn.onJump(absTime(), absTime() + d); flash(skipLabel(d), key); skip(d); };
  const muteH = () => { flash(muted ? 'Sound on' : 'Muted', 'M'); toggleMute(); };
  const volH = (x: number, key?: string) => { const v = Math.round(Math.min(1, Math.max(0, x)) * 100) / 100; flash(`Volume ${Math.round(v * 100)}%`, key); setVol(v); };
  const speedH = (dir: 1 | -1) => {
    const v = videoRef.current; if (!v) return;
    const r = speedStep(v.playbackRate, dir);
    v.playbackRate = r; flash(speedWords(r), dir > 0 ? '>' : '<');
  };
  const frameH = (dir: 1 | -1) => { const v = videoRef.current; if (!v || !v.paused) return; v.currentTime = Math.max(0, v.currentTime + dir / 24); flash(dir > 0 ? 'Next frame' : 'Previous frame', dir > 0 ? '.' : ','); };
  // A seek you make on the bar may be you skipping the titles; resume points and marks are not.
  const userSeek = (t: number) => { introLearn.onJump(absTime(), t); void seekTo(t); };
  const skipIntro = () => { if (!intro?.end) return; introLearn.reset(); flash('Skipped the intro', 'I'); void seekTo(intro.end); };
  const nextH = () => { if (next) { flash(`Next: S${next.season} E${next.episode}`, 'N'); void playNext(); } else flash('No next episode', 'N'); };
  const jumpH = (tenth: number) => { const d = totalDur(); if (!d) return; flash(tenth ? `${tenth * 10}%` : 'Start', String(tenth)); void seekTo(d * tenth / 10); };
  const fullH = () => { flash('Fullscreen', 'F'); fullscreen(videoRef.current, wrapRef.current); };
  const pipH = () => { flash('Picture in picture', 'P'); pip(videoRef.current); };
  // AirPlay: Safari only (iPhone, iPad, Mac). The LG TV speaks AirPlay 2, not Google Cast,
  // so this is how it gets Kino without the Chromecast dongle. Works with native HLS/direct play.
  const airplaySupported = 'WebKitPlaybackTargetAvailabilityEvent' in window;
  const airplay = () => { (videoRef.current as Video | null)?.webkitShowPlaybackTargetPicker?.(); };
  const pipSupported = !!document.pictureInPictureEnabled || typeof (document.createElement('video') as unknown as Record<string, unknown>).webkitSetPresentationMode === 'function';

  // ---- controls visibility ----
  const poke = useCallback(() => {
    setShowCtl(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!videoRef.current?.paused && !sheetOpen) setShowCtl(false); }, 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);
  useEffect(() => { poke(); }, [poke, playing]);
  const onWrapClick = (e: RMouseEvent) => {
    if (onPlayerChrome(e.target, ', .pnotice, .countdown, .skip-intro')) return;
    if (isTouch) {
      // Double tap on the left or right third skips 10 s, like every mobile player.
      const now = { t: Date.now(), x: e.clientX / window.innerWidth };
      const prev = lastTap.current; lastTap.current = now;
      const d = doubleTapSkip(prev, now);
      if (d) {
        introLearn.onJump(absTime(), absTime() + d);
        void skip(d);
        showNotice({ text: skipLabel(d) }, 800);
        lastTap.current = { t: 0, x: now.x };
        return;
      }
      if (showCtl) setShowCtl(false); else poke();
    } else { playPause(); poke(); }
  };
  // Double click toggles fullscreen, also over the visible controls. Its two clicks already toggled play twice, so playback carries on.
  const onWrapDbl = (e: RMouseEvent) => {
    // The big play button sits where people double click; it counts as the video (its two clicks cancel out).
    if (isTouch || (onPlayerChrome(e.target, ', .pnotice, .countdown, .skip-intro') && !(e.target as HTMLElement).closest('.iconbtn.huge'))) return;
    fullH();
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const route = playerKeyRoute(e, (e.target as HTMLElement | null)?.tagName, sheetsRef.current, getStore());
      if (route === 'close-keys') { e.preventDefault(); setKeysOpen(false); }
      if (route !== 'player') return;
      const k = e.key;
      const stop = () => { e.preventDefault(); poke(); };
      if (k === ' ' || k === 'k' || k === 'K') { playPause(); stop(); }
      else if (k === 'ArrowLeft') { skipH(e.shiftKey ? -60 : -10, e.shiftKey ? '⇧ ←' : '←'); stop(); }
      else if (k === 'ArrowRight') { skipH(e.shiftKey ? 60 : 10, e.shiftKey ? '⇧ →' : '→'); stop(); }
      else if (k === 'j' || k === 'J') { skipH(-10, 'J'); stop(); }
      else if (k === 'l' || k === 'L') { skipH(10, 'L'); stop(); }
      else if (/^[0-9]$/.test(k)) { jumpH(Number(k)); stop(); }
      else if (k === 'f' || k === 'F') { fullH(); stop(); }
      else if (k === 'm' || k === 'M') { muteH(); stop(); }
      else if (k === 'p' || k === 'P') { pipH(); stop(); }
      else if (k === 'c' || k === 'C') { openSubs(); stop(); }
      else if (k === 'v' || k === 'V') { toggleSubs(); stop(); }
      else if (k === 'n' || k === 'N') { nextH(); stop(); }
      else if ((k === 'i' || k === 'I') && showIntro) { skipIntro(); stop(); }
      else if (k === 't' || k === 'T') { openDest(); stop(); }
      else if ((k === 's' || k === 'S') && openSources) { openSources(); stop(); }
      else if ((k === 'a' || k === 'A') && openAudio) { openAudio(); stop(); }
      else if (k === 'ArrowUp') { volH(volume + 0.1, '↑'); stop(); }
      else if (k === 'ArrowDown') { volH(volume - 0.1, '↓'); stop(); }
      else if (k === '<') { speedH(-1); stop(); }
      else if (k === '>') { speedH(1); stop(); }
      else if (k === ',') { frameH(-1); stop(); }
      else if (k === '.') { frameH(1); stop(); }
      else if (k === '[' || k === '{') { const d = k === '{' ? 1000 : 100; setSubOffset((o) => { flash(`Subtitles ${offsetLabel(o - d)}`, k === '{' ? '⇧ [' : '['); return o - d; }); stop(); }
      else if (k === ']' || k === '}') { const d = k === '}' ? 1000 : 100; setSubOffset((o) => { flash(`Subtitles ${offsetLabel(o + d)}`, k === '}' ? '⇧ ]' : ']'); return o + d; }); stop(); }
      else if (k === '?') { setKeysOpen(true); stop(); }
      else if (k === 'Escape') { leave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playPause, skip, volume, muted, poke, next, subs, activeSub, showIntro, intro]);

  return { showCtl, poke, playPause, skipH, muteH, userSeek, skipIntro, fullH, pipH: pipSupported ? pipH : undefined, airplay: airplaySupported ? airplay : undefined, onWrapClick, onWrapDbl };
}
