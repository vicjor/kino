import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as RPointerEvent } from 'react';
import { Spring, SPRINGS, VelocityTracker, rubberband, reducedMotion } from '../lib/spring';
import { pageAfter } from '../lib/paging';
import { setStore } from '../lib/store';

export interface Slide { key: string; art?: string; label: string; body: ReactNode }

/**
 * Home's featured shelf, as on the Apple TV app: whole-width slides you swipe with the finger (1:1, rubber-banded past
 * either end, thrown by the release speed onto the next or previous slide on a spring that keeps that speed), or step
 * through with the dots and the arrow keys. It moves on by itself every few seconds, the active dot filling up as it
 * waits, and holds still while a pointer rests on it, while you drag, in a hidden tab and under reduced motion.
 */
export function Featured({ slides, interval = 7000 }: { slides: Slide[]; interval?: number }) {
  const n = slides.length;
  const [page, setPage] = useState(0);
  const [hold, setHold] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const spring = useRef<Spring | null>(null);
  const pageRef = useRef(0); pageRef.current = page;
  const width = () => root.current?.clientWidth || 1;
  const sp = () => (spring.current ??= new Spring(0, (x) => { if (track.current) track.current.style.transform = `translate3d(${x}px, 0, 0)`; }, 0.3));

  const goTo = (i: number, velocity?: number) => {
    const to = Math.max(0, Math.min(n - 1, i));
    sp().to(-to * width(), { velocity, params: velocity != null && Math.abs(velocity) > 200 ? SPRINGS.fling : SPRINGS.smooth });
    setPage(to);
  };
  // Fewer slides than the page we were on (one was hidden): land on the last.
  useEffect(() => { if (page > n - 1 && n > 0) goTo(n - 1); }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new width (rotation, a resize) keeps the same slide in view, without a slide across.
  useLayoutEffect(() => {
    const el = root.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (!sp().moving) sp().set(-pageRef.current * width()); });
    ro.observe(el);
    return () => { ro.disconnect(); spring.current?.stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const f = () => setHidden(document.hidden); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, []);
  // The slide on show lights the page.
  const art = slides[Math.min(page, n - 1)]?.art;
  useEffect(() => { setStore({ ambient: art ?? null }); }, [art]);
  const still = hold || hidden || n < 2 || reducedMotion();
  useEffect(() => {
    if (still) return;
    const t = window.setTimeout(() => goTo((pageRef.current + 1) % n), interval);
    return () => window.clearTimeout(t);
  }, [page, still, n, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag to page. Vertical moves stay page scrolls (touch-action: pan-y), a horizontal one past the slop is ours.
  const drag = useRef<{ id: number; x: number; y: number; from: number; at: number; claimed: boolean } | null>(null);
  const tracker = useRef(new VelocityTracker());
  const dragged = useRef(false);
  const onDown = (e: RPointerEvent) => {
    if (n < 2 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragged.current = false;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pageRef.current, at: sp().value, claimed: false };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.claimed) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(dx) < Math.abs(e.clientY - d.y)) { drag.current = null; return; }
      d.claimed = true; setHold(true);
      sp().stop(); d.at = sp().value; d.x = e.clientX;   // caught mid-slide: hold it under the finger
      track.current?.setPointerCapture(e.pointerId);
      tracker.current.reset();
    }
    const min = -(n - 1) * width();
    const raw = d.at + (e.clientX - d.x);
    const x = raw > 0 ? rubberband(raw, width()) : raw < min ? min - rubberband(min - raw, width()) : raw;
    sp().set(x);
    tracker.current.add(x, performance.now());
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.claimed) return;
    dragged.current = true; setHold(false);
    const v = tracker.current.velocity(performance.now());
    goTo(pageAfter(sp().value, width(), v, d.from, n), v);
  };
  // A swipe ends with the finger on some button: that click is not a tap.
  const onClickCapture = (e: React.MouseEvent) => { if (dragged.current) { dragged.current = false; e.stopPropagation(); e.preventDefault(); } };

  if (!n) return null;
  return (
    <section ref={root} className={`featured${still ? ' still' : ''}`} aria-roledescription="carousel" aria-label="Featured"
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHold(true); }} onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !drag.current) setHold(false); }}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); goTo(page + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(page - 1); } }}>
      <div ref={track} className="featured-track" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClickCapture={onClickCapture}>
        {slides.map((s, i) => (
          <div key={s.key} className="spot featured-slide" role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${n}: ${s.label}`} inert={i !== page}
            style={s.art ? { ['--art' as string]: `url(${s.art})` } : undefined}>
            {s.body}
          </div>
        ))}
      </div>
      {n > 1 ? (
        <div className="featured-dots">
          {slides.map((s, i) => (
            <button key={s.key} className={`featured-dot${i === page ? ' on' : ''}`} aria-label={`Show ${s.label}`} aria-current={i === page ? 'true' : undefined} onClick={() => goTo(i)}>
              {i === page ? <i key={`p${page}`} style={{ animationDuration: `${interval}ms` }} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
