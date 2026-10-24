import { useCallback, useRef, useState } from 'react';
import { isTouch } from '../lib/player-caps';
// Also the cheat sheet's rules (Shortcuts.tsx loads on first open): kept in the first load so the cascade keeps its order.
import '../styles/shortcuts.css';

/* Key caps and the centred HUD: on screen from the start (Home, the cast keys), unlike the cheat sheet. */

export function Keycap({ k }: { k: string }) { return <kbd className="keycap">{k}</kbd>; }

export interface HudState { text: string; key?: string; id: number }

/**
 * A short, centred confirmation of what just happened, with the key that would have done it.
 * Shown for keyboard and mouse alike, so the keys teach themselves.
 */
export function useHud(): { hud: HudState | null; flash: (text: string, key?: string) => void } {
  const [hud, setHud] = useState<HudState | null>(null);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);
  const flash = useCallback((text: string, key?: string) => {
    setHud({ text, key: isTouch ? undefined : key, id: ++seq.current });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHud(null), 900);
  }, []);
  return { hud, flash };
}

export function Hud({ hud }: { hud: HudState | null }) {
  if (!hud) return null;
  return (
    <div key={hud.id} className="hud" aria-live="polite">
      <span>{hud.text}</span>
      {hud.key ? <Keycap k={hud.key} /> : null}
    </div>
  );
}
