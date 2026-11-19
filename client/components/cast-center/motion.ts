import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type PointerEvent as RPointerEvent } from 'react';
import { ZOOM_MS, ZOOM_OUT_MS } from './shared';

/**
 * FLIP: start at the tile's rectangle, settle into the panel. Reverse on leave.
 * The detail is absolute inside the scrollable panel, so it sits at the scroll
 * origin: bring the panel back to the top first or a scrolled phone never sees it.
 */
export function useZoomFlip(el: RefObject<HTMLDivElement | null>, from: DOMRect, leaving: boolean): void {
  const origin = useRef('');
  const prevScroll = useRef(0);
  useLayoutEffect(() => {
    const node = el.current; if (!node) return;
    const panel = node.parentElement;
    if (panel) { prevScroll.current = panel.scrollTop; panel.scrollTop = 0; }
    const to = node.getBoundingClientRect();
    const sx = from.width / to.width, sy = from.height / to.height;
    origin.current = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
    node.style.transition = 'none';
    node.style.transform = origin.current;
    node.style.opacity = '0.6';
    node.getBoundingClientRect(); // flush
    node.style.transition = `transform ${ZOOM_MS}ms cubic-bezier(.32,.72,0,1), opacity ${ZOOM_MS * 0.6}ms ease-out`;
    node.style.transform = 'none';
    node.style.opacity = '1';
  }, [from]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const node = el.current; if (!node || !leaving) return;
    // Put the list back where it was so the zoom-out lands on the tile that was tapped.
    if (node.parentElement) node.parentElement.scrollTop = prevScroll.current;
    node.style.transition = `transform ${ZOOM_OUT_MS}ms cubic-bezier(.4,0,.6,1), opacity ${ZOOM_OUT_MS}ms ease-in`;
    node.style.transform = origin.current;
    node.style.opacity = '0';
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Swipe down anywhere on the header or art to dismiss: how far it has been pulled, and the pointer handlers. */
export function useSwipeDown(onClose: () => void) {
  const drag = useRef<{ y: number; id: number } | null>(null);
  const [dy, setDy] = useState(0);
  const onDown = (e: RPointerEvent) => { if ((e.target as HTMLElement).closest('button, [role=slider], .cc-hist')) return; drag.current = { y: e.clientY, id: e.pointerId }; };
  const onMove = (e: RPointerEvent) => { if (drag.current?.id === e.pointerId) setDy(Math.max(0, e.clientY - drag.current.y)); };
  const onUp = (e: RPointerEvent) => { if (drag.current?.id !== e.pointerId) return; const d = e.clientY - drag.current.y; drag.current = null; setDy(0); if (d > 90) onClose(); };
  return { dy, handlers: { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp } };
}
