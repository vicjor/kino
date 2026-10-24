import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as RPointerEvent } from 'react';
import { tabbables, tabWrap, restoreFocus } from '../lib/focus';
import { Spring, SPRINGS, VelocityTracker, project, rubberband, nearest, reducedMotion } from '../lib/spring';

/**
 * Open sheets, oldest first. One listener for all of them: only the newest answers Esc (so a sheet over a sheet
 * closes alone) and keeps Tab inside itself. A sheet leaves the stack as soon as it starts closing.
 */
interface Layer { panel: HTMLElement; close: () => void }
const layers: Layer[] = [];
function onLayerKey(e: KeyboardEvent): void {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { if (!e.defaultPrevented) { e.preventDefault(); top.close(); } return; }
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && !top.panel.contains(a)) return;   // another overlay (the palette) has the keyboard
  const stops = tabbables(top.panel);
  const to = tabWrap(a ? stops.indexOf(a) : -1, stops.length, e.shiftKey);
  if (to == null) return;
  e.preventDefault();
  (to < 0 ? top.panel : stops[to]).focus();
}
/** A sheet is up and owns the keyboard. False from the moment the last one starts closing. */
export function anySheetOpen(): boolean { return layers.length > 0; }
function pushLayer(l: Layer): void { if (!layers.length) window.addEventListener('keydown', onLayerKey); layers.push(l); }
function dropLayer(l: Layer): void {
  const i = layers.indexOf(l); if (i < 0) return;
  layers.splice(i, 1);
  if (!layers.length) window.removeEventListener('keydown', onLayerKey);
}

/** How the panel arrives: a drawer from the bottom (phones), a dialog in the middle, a glass panel from the right. */
type Mode = 'drawer' | 'dialog' | 'side';
/** Reduced motion: no travel, the panel and the dim only cross-fade, over this long. */
const FADE_MS = 200;
/** Movement before a press becomes a drag, so a tap on a row stays a tap. */
const SLOP = 8;

interface Drag { id: number; x: number; y: number; from: number; claimed: boolean; handle: boolean; caught: boolean }

/**
 * Bottom drawer on phones, centered dialog on desktop. `side`: glass panel in the right quarter on wide screens (video
 * stays visible, no dim), glass drawer on portrait phones. Used over the player.
 *
 * The panel moves on a spring, never a fixed animation: it follows the finger 1:1 from where it was grabbed, resists
 * past the top, can be caught while it is still arriving or leaving, and when let go it keeps the finger's speed. Where
 * it goes is decided by where the flick would carry it (project), not where the finger stopped. `onClose` fires once
 * the panel is out of sight, so unmounting never cuts it short.
 *
 * A modal dialog for assistive tech: named by its title, focus moves in on open, Tab stays inside, and focus
 * goes back to whatever opened it on close.
 */
export function Sheet({ title, onClose, children, side }: { title?: string; onClose: () => void; children: ReactNode; side?: boolean }) {
  const [leaving, setLeaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const titleId = useId();
  // Read at first render, before anything inside the sheet can take focus: the button (or key) that opened it.
  const [opener] = useState(() => document.activeElement);
  const [mode] = useState<Mode>(() => (!window.matchMedia('(min-width: 720px)').matches ? 'drawer' : side ? 'side' : 'dialog'));
  const [still] = useState(reducedMotion);
  const layer = useRef<Layer | null>(null);
  const drag = useRef<Drag | null>(null);
  const tracker = useRef(new VelocityTracker());
  const off = useRef(1);   // px from open to out of sight, along the axis the panel travels
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;

  /** 0 hidden, 1 open; above 1 is a pull past the top, already rubber-banded. */
  const apply = (p: number) => {
    const el = panel.current; if (!el) return;
    const shown = Math.min(1, Math.max(0, p));
    if (dim.current) dim.current.style.opacity = String(shown);
    if (still) { el.style.opacity = String(shown); return; }
    if (mode === 'dialog') { el.style.opacity = String(shown); el.style.transform = `translate3d(0, ${(1 - p) * 16}px, 0) scale(${0.94 + 0.06 * p})`; return; }
    const d = (1 - p) * off.current;
    el.style.transform = mode === 'side' ? `translate3d(${d}px, 0, 0)` : `translate3d(0, ${d}px, 0)`;
  };
  const spring = useRef<Spring | null>(null);
  if (!spring.current) spring.current = new Spring(0, (p) => apply(p), 0.0005);
  const measure = () => {
    const el = panel.current; const back = el?.parentElement; if (!el || !back) return;
    // Layout boxes, not getBoundingClientRect: the panel's own transform must not count.
    off.current = Math.max(1, mode === 'side' ? back.clientWidth - el.offsetLeft + 24 : back.clientHeight - el.offsetTop + 24);
  };

  const finishClose = () => { if (still) window.setTimeout(() => onCloseRef.current(), FADE_MS); else onCloseRef.current(); };
  /** Leave at `velocity` (progress per second, negative toward hidden): a flick keeps its speed on the way out. */
  const close = (velocity?: number) => {
    if (closing.current) return;
    closing.current = true;
    if (layer.current) dropLayer(layer.current);
    restoreFocus(opener, panel.current);
    setLeaving(true);
    measure();
    spring.current!.to(0, { velocity, params: SPRINGS.exit, onRest: finishClose });
  };
  const closeRef = useRef(close); closeRef.current = close;
  /** Caught on its way out: it is a sheet again, on the stack and holding focus. */
  const reopen = () => {
    if (!closing.current) return;
    closing.current = false;
    setLeaving(false);
    const el = panel.current!;
    const l: Layer = { panel: el, close: () => closeRef.current() };
    layer.current = l; pushLayer(l);
    el.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    measure();
    apply(0);
    if (still) void panel.current?.offsetWidth;   // commit the hidden state, so the fade has somewhere to start
    spring.current!.to(1, { params: mode === 'dialog' ? SPRINGS.snappy : SPRINGS.smooth });
    const sp = spring.current!;
    return () => sp.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = panel.current!;
    const l: Layer = { panel: el, close: () => closeRef.current() };
    layer.current = l;
    pushLayer(l);
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    // A downward pull from the top of the body is the sheet's, not a scroll: stop the browser panning, or it would
    // take the gesture (pointercancel) and the sheet would never move. Upward moves stay scrolls.
    const onTouchMove = (e: TouchEvent) => {
      const d = drag.current; const t = e.touches[0]; if (!d || !t) return;
      if (d.claimed) { e.preventDefault(); return; }
      const along = mode === 'side' ? t.clientX - d.x : t.clientY - d.y;
      const across = Math.abs(mode === 'side' ? t.clientY - d.y : t.clientX - d.x);
      if (along > 0 && along >= across && (d.handle || el.scrollTop <= 0)) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    // Unmounted without close() (a parent dropping it at once): still leave the stack and give focus back.
    return () => { el.removeEventListener('touchmove', onTouchMove); dropLayer(l); layer.current = null; restoreFocus(opener, el); };
  }, [opener]); // eslint-disable-line react-hooks/exhaustive-deps

  const along = (e: { clientX: number; clientY: number }) => (mode === 'side' ? e.clientX : e.clientY);
  /** The panel's offset in px for a progress, and back. */
  const toPx = (p: number) => (1 - p) * off.current;

  // Drag from the handle or header, or from the body when it is scrolled to the top. Controls keep their taps.
  const onDown = (e: RPointerEvent) => {
    if (mode === 'dialog' || still) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = panel.current; if (!el) return;
    const target = e.target as HTMLElement;
    const handle = !!target.closest('.sheet-grab, .sheet > h2');
    if (!handle && el.scrollTop > 0 && mode === 'drawer') return;
    if (!handle && target.closest('button, input, select, textarea, a, [role=slider]')) return;
    measure();
    const sp = spring.current!;
    // Caught mid-flight: hold it where it is on screen, under the finger.
    const caught = sp.moving;
    if (caught) sp.stop();
    if (closing.current) reopen();
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: sp.value, claimed: false, handle, caught };
    tracker.current.reset();
    tracker.current.add(toPx(sp.value), performance.now());
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const delta = along(e) - (mode === 'side' ? d.x : d.y);
    if (!d.claimed) {
      const across = Math.abs(mode === 'side' ? e.clientY - d.y : e.clientX - d.x);
      if (Math.abs(delta) < SLOP && across < SLOP) return;
      // Down (or right) is the sheet's; up only from the handle (a rubber-band pull); anything else is a scroll.
      const mine = Math.abs(delta) > across && (delta > 0 || d.handle);
      if (!mine) { drag.current = null; if (d.caught) settle(0); return; }
      d.claimed = true;
      setDragging(true);
      panel.current?.setPointerCapture(e.pointerId);
    }
    const raw = toPx(d.from) + delta;
    const px = raw < 0 ? -rubberband(-raw, off.current) : raw;
    spring.current!.set(1 - px / off.current);
    tracker.current.add(px, performance.now());
  };
  /** Let go: where the flick would carry the panel picks open or gone, and the spring starts at the finger's speed. */
  const settle = (pxPerSec: number) => {
    const sp = spring.current!;
    const px = toPx(sp.value);
    const v = -pxPerSec / off.current;   // progress per second
    if (nearest(px + project(pxPerSec), [0, off.current]) === off.current && pxPerSec >= 0) close(v);
    else sp.to(1, { velocity: v, params: Math.abs(pxPerSec) > 300 ? SPRINGS.fling : SPRINGS.smooth });
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.claimed) { if (d.caught) settle(0); return; }
    setDragging(false);
    settle(tracker.current.velocity(performance.now()));
  };

  return (
    <div className={`sheet-back${side ? ' side' : ''}${leaving ? ' leaving' : ''}`} onClick={(e) => { e.stopPropagation(); close(); }}>
      <div ref={dim} className="sheet-dim" />
      <div ref={panel} className={`sheet${dragging ? ' dragging' : ''}`} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="sheet-grab" aria-hidden="true"><i /></div>
        {title ? <h2 id={titleId}>{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}
