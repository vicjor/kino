import { Spring, SPRINGS, reducedMotion } from './spring';

/**
 * The iOS zoom transition, from a poster card to the title page: the tapped poster lifts off and grows into the page's
 * full-bleed backdrop, turning into the backdrop image as it goes, and dissolves into the real one on arrival. It sets
 * off at once toward a guess (no waiting on the network) and retargets every frame to the real backdrop once that is on
 * screen, so a late layout or a scroll mid-flight only bends the path. Position and size are four springs. Nothing
 * blocks input: the flying copy never takes a tap.
 */
type Rect = { x: number; y: number; w: number; h: number };
const KEYS = ['x', 'y', 'w', 'h'] as const;
const DEST = '.title .hero';
let active: (() => void) | null = null;

/** Where the title page's backdrop sits (title.css .hero heights), before it exists. */
function guess(): Rect {
  const vw = window.innerWidth, vh = window.innerHeight;
  const h = vw >= 720 ? Math.min(860, Math.max(500, Math.min(vh * 0.8, vw * 0.54))) : Math.max(420, Math.min(vh * 0.66, vw * 1.28));
  return { x: 0, y: 0, w: vw, h };
}

/** 0 at the card, 1 at the backdrop, by width: drives the image swap, the corner radius and the final dissolve. */
export function flightProgress(w: number, from: number, to: number): number {
  if (to === from) return 1;
  return Math.min(1, Math.max(0, (w - from) / (to - from)));
}

export function zoomFrom(source: Element | null | undefined, poster: string | undefined, backdrop?: string): void {
  if (!source || !poster || reducedMotion()) return;
  active?.();
  const r = source.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const stale = document.querySelector(DEST);   // the page being left may be a title page too: not the target
  const fly = document.createElement('div');
  fly.className = 'zoom-fly';
  const front = document.createElement('img'); front.alt = ''; front.src = poster;
  fly.appendChild(front);
  let back: HTMLImageElement | null = null;
  if (backdrop) { back = document.createElement('img'); back.alt = ''; back.src = backdrop; back.className = 'zf-back'; fly.prepend(back); }
  document.body.appendChild(fly);
  const from: Rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  const at: Rect = { ...from };
  let target: Rect = guess();
  const draw = () => {
    const t = flightProgress(at.w, from.w, target.w);
    fly.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
    fly.style.width = `${at.w}px`; fly.style.height = `${at.h}px`;
    fly.style.borderRadius = `${12 * (1 - t)}px`;
    if (back) front.style.opacity = String(1 - Math.min(1, t * 1.6));
    fly.style.opacity = String(t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15);   // dissolve into the real backdrop on arrival
  };
  draw();
  const springs = Object.fromEntries(KEYS.map((k) => [k, new Spring(at[k], (v) => { at[k] = v; draw(); }, 0.3)])) as Record<keyof Rect, Spring>;
  let dest: HTMLElement | null = null;
  let raf = 0;
  let over = false;
  const started = performance.now();

  const finish = () => {
    if (over) return;
    over = true; active = null;
    cancelAnimationFrame(raf);
    for (const k of KEYS) springs[k].stop();
    fly.style.transition = 'opacity .18s ease'; fly.style.opacity = '0';
    window.setTimeout(() => fly.remove(), 200);
  };
  active = finish;
  const go = (t: Rect) => { target = t; for (const k of KEYS) springs[k].to(t[k], { params: SPRINGS.smooth }); };
  go(target);

  const tick = () => {
    if (over) return;
    if (!dest) {
      const d = document.querySelector<HTMLElement>(DEST);
      if (d && d !== stale && d.getBoundingClientRect().height > 0) dest = d;
    } else if (!dest.isConnected) { finish(); return; }
    if (dest) {
      const b = dest.getBoundingClientRect();
      const t = { x: b.left, y: b.top, w: b.width, h: b.height };
      if (KEYS.some((k) => Math.abs(t[k] - target[k]) > 0.5)) go(t);
    } else if (performance.now() - started > 1500) { finish(); return; }   // the page never showed a backdrop
    if (KEYS.every((k) => !springs[k].moving)) { finish(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
