import { useEffect, useState } from 'react';
import type { CastStatus } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore, getStore, toast } from '../lib/store';
import { tvVolume, stepVolume, setTvVolume, type VolumeChange } from '../lib/cast-volume';
import { handoffHere } from '../lib/cast-actions';
import { isTouch } from '../lib/player-caps';
import { chordPending } from '../lib/keys';
import { langName } from '../lib/format';
import { Hud, useHud } from './Hud';
import { CastShortcutsSheet } from './LazyOverlays';
import { openDeviceController } from '../lib/overlays';
import { anySheetOpen } from './Sheet';

/** Any surface can ask for the cheat sheet (the keys row under the Home hero does). */
export const OPEN_CAST_KEYS = 'kino:castkeys';

/**
 * The cast controller's keys, everywhere. While Kino casts and you sit on Home or a title page, Space still
 * pauses the TV, the arrows still seek it and every press flashes what it did, exactly like the player.
 * The Cast Center, the player and any sheet bind their own keys; this steps aside while one has the keyboard.
 */
export function CastHotkeys() {
  const cast = useStore((s) => s.cast);
  const ccOpen = useStore((s) => s.ccOpen);
  const { hud, flash } = useHud();
  const [keys, setKeys] = useState(false);
  useEffect(() => { const open = () => setKeys(true); window.addEventListener(OPEN_CAST_KEYS, open); return () => window.removeEventListener(OPEN_CAST_KEYS, open); }, []);
  useEffect(() => {
    if (isTouch || !cast.active || ccOpen) return;
    const apply = (f: () => Promise<CastStatus>) => f().then((c) => setStore({ cast: c })).catch((e) => toast((e as Error).message, 'error'));
    const playing = cast.state === 'PLAYING';
    const dur = cast.duration || 0; const pos = cast.currentTime || 0;
    const isSeries = cast.type === 'series';
    const seekTo = (t: number) => apply(() => api.castSeek(Math.max(0, Math.min(dur ? dur - 1 : t, t))));
    const skip = (d: number, key: string) => { if (!dur) return; flash(`${d > 0 ? '+' : '−'}${Math.abs(d) >= 60 ? `${Math.abs(d) / 60} min` : `${Math.abs(d)} s`}`, key); void seekTo(pos + d); };
    // Read the store at press time: a held arrow key builds on the level the previous press set.
    const tv = () => { const s = getStore(); return tvVolume(s.cast, s.receivers); };
    const setVol = (b: VolumeChange) => { setTvVolume(tv(), b).catch((e) => toast((e as Error).message, 'error')); };
    const vol = (d: number, key: string) => { if (tv().unknown) return; const v = stepVolume(tv().level, d); flash(`Volume ${Math.round(v * 100)}%`, key); setVol({ level: v, muted: false }); };
    const mute = () => { if (tv().unknown) return; const m = tv().muted; flash(m ? 'Sound on' : 'Muted', 'M'); setVol({ muted: !m }); };
    const subs = () => {
      const avail = (cast.subs || []).filter((t) => t.available);
      if (cast.activeSubId) { flash('Subtitles off', 'V'); void apply(() => api.castSubtitle(null)); return; }
      const t = avail.find((x) => x.recommended) || avail[0];
      if (t) { flash(`Subtitles: ${langName(t.lang)}`, 'V'); void apply(() => api.castSubtitle(t.id)); } else flash('No subtitles', 'V');
    };
    const here = () => { flash('Playing here', 'H'); handoffHere(cast).catch((e) => toast((e as Error).message, 'error')); };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      if (keys) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); setKeys(false); } return; }
      const s = getStore();
      if (anySheetOpen() || s.ccOpen || s.palOpen) return;   // a sheet, the Cast Center or the palette owns the keys
      if (chordPending(e)) return;   // "g h", "g l", "g m" are the palette's, not the TV's
      const k = e.key; const stop = () => e.preventDefault();
      if (k === ' ' || k === 'k' || k === 'K') { flash(playing ? 'Pause' : 'Play', 'K'); void apply(() => (playing ? api.castPause() : api.castResume())); stop(); }
      else if (k === 'ArrowLeft') { skip(e.shiftKey ? -60 : -10, e.shiftKey ? '⇧ ←' : '←'); stop(); }
      else if (k === 'ArrowRight') { skip(e.shiftKey ? 60 : 10, e.shiftKey ? '⇧ →' : '→'); stop(); }
      else if (k === 'j' || k === 'J') { skip(-10, 'J'); stop(); }
      else if (k === 'l' || k === 'L') { skip(10, 'L'); stop(); }
      else if (/^[0-9]$/.test(k)) { if (dur) { const n = Number(k); flash(n ? `${n * 10}%` : 'Start', k); void seekTo(dur * n / 10); } stop(); }
      else if (k === 'ArrowUp') { vol(0.05, '↑'); stop(); }
      else if (k === 'ArrowDown') { vol(-0.05, '↓'); stop(); }
      else if (k === 'm' || k === 'M') { mute(); stop(); }
      else if (k === 'n' || k === 'N') { if (isSeries) { flash('Next episode', 'N'); void apply(() => api.castNext()); } else flash('No next episode', 'N'); stop(); }
      else if (k === 'v' || k === 'V') { subs(); stop(); }
      else if (k === 'e' || k === 'E') { if (isSeries) { flash(cast.stopAfter ? 'Auto-next on' : 'Stopping after this episode', 'E'); void apply(() => api.castUpNext(!cast.stopAfter)); } stop(); }
      else if (k === 'x' || k === 'X') { flash('Stopped', 'X'); void apply(() => api.castStop()); stop(); }
      else if (k === 'h' || k === 'H') { here(); stop(); }
      else if ((k === 's' || k === 'S') && cast.deviceId) { openDeviceController(cast.deviceId); stop(); }
      else if (k === '?') { setKeys(true); stop(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cast, ccOpen, keys, flash]);
  if (isTouch) return null;
  return (
    <>
      {hud ? <div className="cast-hud"><Hud hud={hud} /></div> : null}
      {keys ? <CastShortcutsSheet onClose={() => setKeys(false)} title="Keyboard shortcuts for the TV" /> : null}
    </>
  );
}
