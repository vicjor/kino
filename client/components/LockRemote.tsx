import { useEffect } from 'react';
import type { ReceiverInfo } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore, getStore, toast } from '../lib/store';
import { useRoute } from '../lib/router';
import { isTouch } from '../lib/player-caps';

// Lock-screen remote for a Cast device, Spotify style. A web page only gets
// lock-screen / notification controls (MediaSession) while it is itself
// playing audio, so we loop a silent clip and mirror the TV's state into the
// session: title, artwork, position, and play/pause/seek/stop map to the
// device. Opt-in per device from the Cast Center, because it takes over the
// phone's audio session (anything playing on the phone pauses).

// 1 second of 8 kHz mono silence as a WAV (tiny, loops without gaps).
const SILENCE = (() => {
  const rate = 8000, n = rate; const buf = new ArrayBuffer(44 + n); const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();

export const lockRemoteSupported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;

// The silent loop must start inside the user's tap (autoplay rules), so the
// toggle owns the element; the component only mirrors state and stops it.
let audioEl: HTMLAudioElement | null = null;
/** Devices the user switched the remote off for during this cast; auto-arm leaves them alone. */
const declined = new Set<string>();
export function toggleLockRemote(deviceId: string): void {
  if (getStore().lockRemote === deviceId) { audioEl?.pause(); setStore({ lockRemote: null }); declined.add(deviceId); return; }
  if (!audioEl) { audioEl = new Audio(SILENCE); audioEl.loop = true; audioEl.volume = 0.01; }
  audioEl.play().then(() => setStore({ lockRemote: deviceId })).catch(() => toast('Could not start the lock-screen remote (audio blocked)', 'error'));
}

export function LockRemote() {
  const deviceId = useStore((s) => s.lockRemote);
  const receivers = useStore((s) => s.receivers);
  const r: ReceiverInfo | undefined = deviceId ? (receivers || []).find((x) => x.id === deviceId) : undefined;
  useEffect(() => { if (!deviceId) audioEl?.pause(); }, [deviceId]);

  // Automatic on phones: while Kino is casting and the remote is off, the next tap anywhere arms it.
  // A tap is needed because the silent loop is audio and iOS only starts audio inside a gesture.
  const cast = useStore((s) => s.cast);
  const route = useRoute();
  // The player playing here owns the media session; as the TV's remote (tv in the link) it does not.
  const inPlayer = route.path.startsWith('/play') && route.query.get('tv') !== 'true';
  useEffect(() => { if (!cast.active) declined.clear(); }, [cast.active]);
  useEffect(() => {
    const id = cast.deviceId;
    if (!isTouch || !lockRemoteSupported || !cast.active || !id || deviceId || inPlayer || declined.has(id)) return;
    const arm = () => { const s = getStore(); if (!s.lockRemote && s.cast.active && s.cast.deviceId === id && !declined.has(id)) toggleLockRemote(id); };
    document.addEventListener('pointerup', arm, { once: true, capture: true });
    return () => document.removeEventListener('pointerup', arm, { capture: true });
  }, [cast.active, cast.deviceId, deviceId, inPlayer]);

  // iOS drops the Now Playing card if the silent loop stops (interruptions, a
  // call): resume it whenever we come back to the foreground.
  useEffect(() => {
    if (!deviceId) return;
    const resume = () => { const tv = (getStore().receivers || []).find((x) => x.id === deviceId)?.media?.state; if (document.visibilityState === 'visible' && audioEl?.paused && tv !== 'PAUSED') audioEl.play().catch(() => undefined); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [deviceId]);
  // Card identity (title, artwork) only when it changes; re-creating it every
  // few seconds makes the lock screen flicker and sometimes lose the card.
  const ident = r ? `${r.media?.title || ''}|${r.media?.artwork || ''}|${r.media?.subtitle || ''}|${r.app?.name || ''}|${r.name}` : '';
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || !deviceId || !r) return;
    const m = r.media;
    try {
      ms.metadata = new MediaMetadata({
        title: m?.title || r.app?.name || r.name,
        artist: [r.name, r.kino ? 'Kino' : m?.title ? r.app?.name : null].filter(Boolean).join(' · '),
        album: m?.subtitle || 'Kino remote',
        artwork: m?.artwork ? [{ src: m.artwork, sizes: '512x512' }] : [],
      });
    } catch { /* unsupported field */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, ident]);
  // state + position + handlers
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || !deviceId) return;
    if (!r) return;
    const m = r.media;
    // iOS shows the state and timeline of the audio that is actually playing, not playbackState, so the
    // silent loop has to pause and resume with the TV. The card survives a paused loop, like any paused app.
    if (audioEl) { if (m?.state === 'PAUSED') audioEl.pause(); else if (audioEl.paused && document.visibilityState === 'visible') audioEl.play().catch(() => undefined); }
    try {
      ms.playbackState = m?.state === 'PAUSED' ? 'paused' : 'playing';
      if (m?.duration && m.duration > 0 && 'setPositionState' in ms) ms.setPositionState({ duration: m.duration, position: Math.max(0, Math.min(m.duration, m.currentTime || 0)), playbackRate: m.state === 'PAUSED' ? 0 : 1 });
    } catch { /* unsupported field */ }
    const cmd = (c: 'play' | 'pause' | 'stop' | 'seek', body?: { time?: number }) => api.castReceiverCmd(deviceId, c, body).catch((e) => toast((e as Error).message, 'error'));
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch { /* unsupported */ } };
    set('play', () => { void cmd('play'); audioEl?.play().catch(() => undefined); });
    set('pause', () => { void cmd('pause'); });
    set('stop', () => { void cmd('stop'); setStore({ lockRemote: null }); });
    set('seekbackward', (d) => { void cmd('seek', { time: Math.max(0, (m?.currentTime || 0) - (d.seekOffset || 15)) }); });
    set('seekforward', (d) => { void cmd('seek', { time: (m?.currentTime || 0) + (d.seekOffset || 15) }); });
    set('seekto', (d) => { if (d.seekTime != null) void cmd('seek', { time: d.seekTime }); });
    set('nexttrack', null); set('previoustrack', null);
    return () => { for (const a of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto'] as MediaSessionAction[]) set(a, null); };
  }, [deviceId, r?.media?.state, r?.media?.title, r?.media?.currentTime, r?.media?.duration, r?.media?.artwork, r?.name, r?.app?.name, r?.kino]);

  // device went away or stopped: release
  useEffect(() => { if (deviceId && receivers && r && !r.online) setStore({ lockRemote: null }); }, [deviceId, receivers, r]);
  return null;
}
