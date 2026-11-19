import { useEffect, useState } from 'react';
import type { CastStatus } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore, getStore, toast } from '../lib/store';
import { tvVolume, stepVolume, setTvVolume, type VolumeChange } from '../lib/cast-volume';
import { handoffHere } from '../lib/cast-actions';
import { isTouch } from '../lib/player-caps';
import { chordPending } from '../lib/keys';
import { castKeyAction, type CastKey } from '../lib/cast-keys';
import { langName, skipLabel } from '../lib/format';
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
    const skip = (d: number, key: string) => { if (!dur) return; flash(skipLabel(d), key); void seekTo(pos + d); };
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
      const a = castKeyAction(e);
      if (a && run(a) !== false) e.preventDefault();
    };
    // false: not a key here right now, so the press is left alone.
    const run = (a: CastKey): boolean | void => {
      switch (a.do) {
        case 'play-pause': flash(playing ? 'Pause' : 'Play', 'K'); void apply(() => (playing ? api.castPause() : api.castResume())); return;
        case 'skip': skip(a.by, a.key); return;
        case 'jump': if (dur) { flash(a.tenth ? `${a.tenth * 10}%` : 'Start', String(a.tenth)); void seekTo(dur * a.tenth / 10); } return;
        case 'volume': vol(a.by, a.key); return;
        case 'mute': mute(); return;
        case 'next': if (isSeries) { flash('Next episode', 'N'); void apply(() => api.castNext()); } else flash('No next episode', 'N'); return;
        case 'subs': subs(); return;
        case 'stop-after': if (isSeries) { flash(cast.stopAfter ? 'Auto-next on' : 'Stopping after this episode', 'E'); void apply(() => api.castUpNext(!cast.stopAfter)); } return;
        case 'stop': flash('Stopped', 'X'); void apply(() => api.castStop()); return;
        case 'here': here(); return;
        case 'source': if (!cast.deviceId) return false; openDeviceController(cast.deviceId); return;
        case 'keys': setKeys(true); return;
        case 'intro': return false;   // skip intro lives in the player and the controller, not here
      }
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
