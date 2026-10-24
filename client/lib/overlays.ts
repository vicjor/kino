import type * as CastCenterModule from '../components/CastCenter';
import { getStore, setStore, toast } from './store';
import { navigate } from './router';
import { startChord, endChord, chordPending } from './keys';

/*
 * Opening an overlay is a store write, so a button that opens one never imports its code. The Cast Center and
 * the command palette mount the first time they open (see App) and their code arrives then, or on idle before.
 */

export const LOAD_FAILED = 'That did not open. Check that the Mac is awake and on the network, then try again.';

export function openCastCenter(): void { setStore({ ccOpen: true, ccOrigin: null }); }
export function openPalette(): void { setStore({ palOpen: true }); }
export function closePalette(): void { setStore({ palOpen: false }); }

/** The Cast Center's module once it is here, so opening a device after that takes no extra tick. */
let castCenter: typeof CastCenterModule | null = null;
export const loadCastCenter = () => import('../components/CastCenter').then((m) => (castCenter = m));

/** Open the Cast Center already zoomed into one device's controller, growing out of `from` (a bar, a widget). */
export function openDeviceController(id: string, from?: DOMRect | null): void {
  // The device to zoom into is handed over inside CastCenter.tsx, so its code has to be here first.
  if (castCenter) castCenter.openDeviceController(id, from);
  else loadCastCenter().then((m) => m.openDeviceController(id, from), () => toast(LOAD_FAILED, 'error', 6000));
}

/**
 * The palette's keys, listening from the start: Cmd/Ctrl+K opens or closes it, and Linear-style "g" chords
 * navigate when not typing (g h / g s / g b / g l / g m / g , and g c for the Cast Center).
 */
export function onPaletteKey(e: KeyboardEvent): void {
  const open = getStore().palOpen;
  const typing = (el: HTMLElement | null) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (open) closePalette(); else openPalette(); return; }
  if (open || typing(e.target as HTMLElement | null) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'g') { startChord(); return; }
  if (chordPending()) {
    const to: Record<string, string> = { h: '/', s: '/search', b: '/browse/all', l: '/library', m: '/magnet', ',': '/settings' };
    if (to[e.key]) { e.preventDefault(); navigate(to[e.key]); }
    else if (e.key === 'c') { e.preventDefault(); setStore({ ccOpen: true }); }
    endChord(e);
  }
}
