import { useEffect, useRef, type RefObject } from 'react';
import { Spring, SPRINGS, VelocityTracker, project, rubberband } from '../lib/spring';

/** Buttons, sliders and open menus keep their own gestures: a pull starts only on the picture or the backdrop. */
const OWN = 'button, a, input, [role="slider"], .playon-menu, .sheet, .sheet-back, .upnext';

/**
 * Pull a full-screen player down to put it away, as on iOS. The page follows the finger 1:1 and shrinks a little as
 * it goes, resisting an upward pull; on release the flick is projected forward and a pull heading past a third of the
 * screen dismisses (the spring keeps the finger's speed on the way out), anything shorter springs back. Touch only,
 * and only from the top of a page that scrolls. The tap that a pull ends with is swallowed.
 */
export function usePullDown(ref: RefObject<HTMLElement | null>, onDismiss: () => void, enabled = true): void {
  // The player re-renders several times a second: the listeners stay put and read the latest handler from here.
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const draw = (y: number) => {
      if (!y) { el.style.transform = ''; el.style.borderRadius = ''; el.style.boxShadow = ''; return; }
      const k = Math.max(0, y) / Math.max(1, el.clientHeight);
      el.style.transform = `translate3d(0, ${y}px, 0) scale(${1 - k * 0.14})`;
      el.style.borderRadius = `${Math.min(36, Math.max(0, y) / 5)}px`;
      // A hairline and a shadow, so a dark picture still reads as a card leaving over a dark page.
      el.style.boxShadow = '0 0 0 1px rgba(255,255,255,.1), 0 30px 90px rgba(0,0,0,.7)';
    };
    const spring = new Spring(0, draw);
    const tracker = new VelocityTracker();
    let start: { id: number; x: number; y: number } | null = null;
    let claimed = false;
    let done = false;
    const swallowClick = () => {
      const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      el.addEventListener('click', stop, { capture: true, once: true });
      window.setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 400);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || done || el.hasAttribute('data-rotated') || (e.target as HTMLElement).closest(OWN) || el.scrollTop > 0) return;
      start = { id: e.pointerId, x: e.clientX, y: e.clientY }; claimed = false;
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dy = e.clientY - start.y, dx = e.clientX - start.x;
      if (!claimed) {
        if (Math.abs(dy) < 12 && Math.abs(dx) < 12) return;
        if (dy < 0 || Math.abs(dx) > Math.abs(dy)) { start = null; return; }
        claimed = true; spring.stop(); tracker.reset();
        try { el.setPointerCapture(e.pointerId); } catch { /* gone already */ }
        start.y = e.clientY - spring.value;   // caught on its way back: carry on from where it is
      }
      const raw = e.clientY - start.y;
      const y = raw < 0 ? -rubberband(-raw, el.clientHeight) : raw;
      spring.set(y);
      tracker.add(y, performance.now());
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      if (!claimed) return;
      claimed = false;
      swallowClick();
      const v = tracker.velocity(performance.now());
      const h = el.clientHeight;
      if (e.type !== 'pointercancel' && spring.value + project(v, 0.99) > h / 3 && v > -200) {
        done = true;
        spring.to(h, { velocity: Math.max(v, 1200), params: SPRINGS.exit, onRest: () => dismiss.current() });
      } else spring.to(0, { velocity: v, params: SPRINGS.fling });
    };
    // The browser starts a scroll (and cancels the pointer) on the first move unless that move is refused: a downward
    // move from the top of the page is ours from the start, before it is far enough to claim.
    const touchMove = (e: TouchEvent) => {
      if (!e.cancelable) return;
      const t = e.touches[0];
      if (claimed || (start && t && el.scrollTop <= 0 && t.clientY > start.y && t.clientY - start.y >= Math.abs(t.clientX - start.x))) e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('touchmove', touchMove, { passive: false });
    return () => {
      spring.stop();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('touchmove', touchMove);
    };
  }, [ref, enabled]);
}
