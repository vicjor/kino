import { useEffect, useRef } from 'react';
import { useRoute, back, navigate } from '../lib/router';
import { toast, getStore } from '../lib/store';
import { anySheetOpen } from './Sheet';

/** Screens where you may be mid-typing: the first Esc only warns, the second within a moment leaves. */
const GUARDED = new Set(['settings', 'magnet']);
const ARM_MS = 2500;

/** A sheet, the Cast Center or the palette is up: it handles Esc and "/" itself. */
function overlayOpen(): boolean { const s = getStore(); return anySheetOpen() || s.ccOpen || s.palOpen; }

/**
 * Esc goes back on every screen except Home and the player (which has its own). Overlays win: an open
 * sheet, the Cast Center or the palette handle Esc themselves, and a focused field just loses focus.
 * One listener for the app's lifetime, added before any overlay's: it reads the overlay state as it was
 * before an overlay's own handler closed it on this same key press.
 */
export function EscapeNav() {
  const route = useRoute();
  const head = useRef('');
  const armed = useRef(0);
  useEffect(() => { head.current = route.parts[0] || ''; }, [route.parts]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = head.current;
      if (h === 'play') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el0 = document.activeElement as HTMLElement | null;
      const typing = !!el0 && (el0.tagName === 'INPUT' || el0.tagName === 'TEXTAREA' || el0.isContentEditable);
      if (e.key === '/' && !typing && !overlayOpen()) { e.preventDefault(); navigate('/search'); return; }
      if (e.key !== 'Escape') return;
      if (overlayOpen()) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) { el.blur(); e.preventDefault(); return; }
      if (!h) return;
      e.preventDefault();
      if (GUARDED.has(h) && Date.now() - armed.current > ARM_MS) { armed.current = Date.now(); toast('Press Esc again to leave', 'info', ARM_MS); return; }
      armed.current = 0;
      back('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
