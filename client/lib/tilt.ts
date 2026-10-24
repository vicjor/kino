import { reducedMotion } from './spring';

/**
 * tvOS-style hover for artwork: the poster under a mouse tilts toward the pointer and a highlight follows it. Only
 * writes four CSS variables on the poster (cards.css and title.css turn them into the tilt and the shine), so nothing
 * re-renders. Mouse only: a finger has no hover, and reduced motion keeps the posters flat.
 */
const POSTERS = '.card .poster, .epc .epc-thumb';
const VARS = ['--rx', '--ry', '--mx', '--my'];
const MAX_DEG = 7;

/** The tilt for a pointer at (x, y), each 0..1 across the poster: toward the pointer, at most MAX_DEG either way. */
export function tiltAt(x: number, y: number): { rx: number; ry: number } {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return { rx: (c(x) - 0.5) * 2 * MAX_DEG, ry: (0.5 - c(y)) * 2 * MAX_DEG };
}

export function installTilt(): void {
  if (typeof window === 'undefined' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches || reducedMotion()) return;
  let current: HTMLElement | null = null;
  const reset = (el: HTMLElement) => { for (const v of VARS) el.style.removeProperty(v); };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const card = (e.target as Element | null)?.closest?.('.card, .epc');
    const poster = card?.querySelector<HTMLElement>(POSTERS) ?? null;
    if (poster !== current) { if (current) reset(current); current = poster; }
    if (!poster) return;
    const r = poster.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const { rx, ry } = tiltAt(x, y);
    poster.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    poster.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    poster.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    poster.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (current) { reset(current); current = null; } });
}
