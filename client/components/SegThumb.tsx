import { useLayoutEffect, useRef } from 'react';
import { Spring, SPRINGS } from '../lib/spring';

/**
 * The thumb of a segmented control. Put it first inside a `.seasons` row: after every render of the row it finds the
 * `.seg.on` and springs there, position and width as two springs, so a pick made mid-slide turns smoothly from where
 * the thumb is. Lands without moving the first time and on layout changes nobody tapped for.
 */
export function SegThumb() {
  const ref = useRef<HTMLSpanElement>(null);
  const springs = useRef<{ x: Spring; w: Spring } | null>(null);
  const place = (animate: boolean) => {
    const el = ref.current; const box = el?.parentElement; if (!el || !box) return;
    const on = box.querySelector<HTMLElement>(':scope > .seg.on');
    if (!on) { el.style.opacity = '0'; return; }
    el.style.opacity = '';
    springs.current ??= {
      x: new Spring(0, (v) => { el.style.transform = `translateX(${v}px)`; }),
      w: new Spring(0, (v) => { el.style.width = `${v}px`; }),
    };
    const { x, w } = springs.current;
    el.style.top = `${on.offsetTop}px`; el.style.height = `${on.offsetHeight}px`;
    const tx = on.offsetLeft, tw = on.offsetWidth;
    const ready = el.classList.contains('ready');
    for (const [s, t] of [[x, tx], [w, tw]] as const) {
      if (s.goal === t && ready) continue;
      if (animate && ready) s.to(t, { params: SPRINGS.snappy }); else s.set(t);
    }
    el.classList.add('ready');
  };
  // Every render: the row re-rendered, so the chosen segment may have changed.
  useLayoutEffect(() => place(true));
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => place(!!springs.current && (springs.current.x.moving || springs.current.w.moving)));
    ro.observe(box);
    for (const c of box.children) ro.observe(c);
    return () => { ro.disconnect(); springs.current?.x.stop(); springs.current?.w.stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={ref} className="seg-thumb" aria-hidden="true" />;
}
