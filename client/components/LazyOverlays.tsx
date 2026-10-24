import { Component, Suspense, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { setStore, toast } from '../lib/store';
import { LOAD_FAILED, closePalette, loadCastCenter } from '../lib/overlays';

/*
 * Overlays whose code is not in the first load. Each renders at once when its code is already here (fetched on
 * idle through `preload`, or opened before) and otherwise shows nothing until it arrives. Either way it mounts
 * fresh, so its own open animation plays.
 */

/** The overlay's code did not arrive (the Mac asleep, the phone between networks) or it threw: say so and close it. */
class LoadBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { toast(LOAD_FAILED, 'error', 6000); this.props.onFail(); }
  override render() { return this.state.failed ? null : this.props.children; }
}

function deferred<P extends object>(load: () => Promise<ComponentType<P>>, close: (props: P) => void) {
  let ready: ComponentType<P> | null = null;
  const fetchCode = () => load().then((c) => (ready = c));
  const fresh = () => lazy(() => fetchCode().then((c) => ({ default: c })));
  let Lazy = fresh();
  function Deferred(props: P) {
    // One component for this mount: swapping Lazy for the loaded one later would remount it.
    const [C] = useState<ComponentType<P>>(() => ready ?? Lazy);
    // A failed lazy stays failed, so the next open asks again. A browser that keeps the failed import gets the
    // reload in main.tsx (vite:preloadError) instead.
    return <LoadBoundary onFail={() => { Lazy = fresh(); close(props); }}><Suspense fallback={null}><C {...props} /></Suspense></LoadBoundary>;
  }
  return Object.assign(Deferred, {
    preload: () => { if (!ready) fetchCode().catch(() => undefined); },
    isReady: () => !!ready,
  });
}

export const CastCenter = deferred(() => loadCastCenter().then((m) => m.CastCenter), () => setStore({ ccOpen: false }));
export const CommandPalette = deferred(() => import('./CommandPalette').then((m) => m.CommandPalette), closePalette);
export const CastPicker = deferred<ComponentProps<typeof import('./CastPicker').CastPicker>>(() => import('./CastPicker').then((m) => m.CastPicker), (p) => p.onClose());
/** The cheat sheet of the cast keys (CastHotkeys, and the Home hero through it). */
export const CastShortcutsSheet = deferred<{ onClose: () => void; title?: string }>(
  () => import('./Shortcuts').then(({ ShortcutsSheet, CAST_SHORTCUTS }) => (p) => <ShortcutsSheet {...p} groups={CAST_SHORTCUTS} />),
  (p) => p.onClose());
