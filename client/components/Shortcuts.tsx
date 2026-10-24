import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { Keycap } from './Hud';
import { isTouch } from '../lib/player-caps';

// The cheat sheet loads on first open; the key caps and the HUD (Hud.tsx) are on screen from the start.
export { Keycap, Hud, useHud } from './Hud';

/** The whole map, in the order the cheat sheet shows it. Keys are display labels. */
export const SHORTCUTS: { group: string; items: { keys: string[]; what: string }[] }[] = [
  { group: 'Playback', items: [
    { keys: ['Space', 'K'], what: 'Play or pause' },
    { keys: ['N'], what: 'Next episode' },
    { keys: ['I'], what: 'Skip the intro, while it plays' },
    { keys: ['<', '>'], what: 'Slower or faster' },
    { keys: [',', '.'], what: 'Step one frame while paused' },
  ] },
  { group: 'Seek', items: [
    { keys: ['J', '←'], what: 'Back 10 seconds' },
    { keys: ['L', '→'], what: 'Forward 10 seconds' },
    { keys: ['⇧ ←', '⇧ →'], what: 'Back or forward 1 minute' },
    { keys: ['0 … 9'], what: 'Jump to 0% … 90%' },
  ] },
  { group: 'Sound', items: [
    { keys: ['↑', '↓'], what: 'Volume' },
    { keys: ['M'], what: 'Mute' },
    { keys: ['A'], what: 'Audio track' },
  ] },
  { group: 'Subtitles', items: [
    { keys: ['C'], what: 'Subtitle menu' },
    { keys: ['V'], what: 'Subtitles on or off' },
    { keys: ['[', ']'], what: 'Nudge sync 0.1 s' },
    { keys: ['⇧ [', '⇧ ]'], what: 'Nudge sync 1 s' },
  ] },
  { group: 'View', items: [
    { keys: ['F'], what: 'Fullscreen' },
    { keys: ['P'], what: 'Picture in picture' },
    { keys: ['T'], what: 'Cast to a device' },
    { keys: ['S'], what: 'Switch source' },
    { keys: ['?'], what: 'This list' },
    { keys: ['Esc'], what: 'Back' },
  ] },
];

/** The device controller in the Cast Center. Same keys as the player where the action exists. */
export const CAST_SHORTCUTS: typeof SHORTCUTS = [
  { group: 'Playback on the TV', items: [
    { keys: ['Space', 'K'], what: 'Play or pause' },
    { keys: ['J', '←'], what: 'Back 10 seconds' },
    { keys: ['L', '→'], what: 'Forward 10 seconds' },
    { keys: ['⇧ ←', '⇧ →'], what: 'Back or forward 1 minute' },
    { keys: ['0 … 9'], what: 'Jump to 0% … 90%' },
    { keys: ['N'], what: 'Next episode' },
    { keys: ['I'], what: 'Skip the intro, while it plays' },
    { keys: ['E'], what: 'Stop after this episode' },
  ] },
  { group: 'Sound', items: [
    { keys: ['↑', '↓'], what: 'TV volume' },
    { keys: ['M'], what: 'Mute' },
  ] },
  { group: 'Stream', items: [
    { keys: ['V'], what: 'Subtitles on or off' },
    { keys: ['S'], what: 'Switch source' },
    { keys: ['H'], what: 'Play here instead' },
    { keys: ['X'], what: 'Stop casting' },
  ] },
  { group: 'View', items: [
    { keys: ['?'], what: 'This list' },
    { keys: ['Esc'], what: 'Back' },
  ] },
];

export function ShortcutsSheet({ onClose, groups = SHORTCUTS, title = 'Keyboard shortcuts' }: { onClose: () => void; groups?: typeof SHORTCUTS; title?: string }) {
  return (
    <Sheet title={title} onClose={onClose} side>
      <div className="keys-grid">
        {groups.map((g) => (
          <section key={g.group} className="keys-group">
            <h3>{g.group}</h3>
            {g.items.map((it) => (
              <div key={it.what} className="keys-row">
                <span className="keys-caps">{it.keys.map((k, i) => <span key={k}>{i ? <span className="keys-or">or</span> : null}<Keycap k={k} /></span>)}</span>
                <span className="keys-what">{it.what}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}

const NUDGE_KEY = 'kino.keys.nudged';
/** "Press ? for shortcuts", the first three times the player opens on a keyboard machine. */
export function useShortcutNudge(): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (isTouch) return;
    let n = 0; try { n = Number(localStorage.getItem(NUDGE_KEY) || 0); } catch { /* ignore */ }
    if (n >= 3) return;
    try { localStorage.setItem(NUDGE_KEY, String(n + 1)); } catch { /* ignore */ }
    setShow(true);
    const t = window.setTimeout(() => setShow(false), 9000);
    return () => window.clearTimeout(t);
  }, []);
  return show;
}
