/**
 * Springs the way Apple tunes them: a damping ratio (1 = settles without overshoot, below 1 bounces) and a response
 * (seconds, how quick it gets there; not a duration). Everything a finger touches moves on one of these, so a motion
 * can be grabbed mid-flight and starts again from where it is on screen, at the speed it was going.
 */
export interface SpringParams { damping: number; response: number }

export const SPRINGS = {
  /** Default: arrive, reposition. No overshoot. */
  smooth: { damping: 1, response: 0.4 },
  /** Small things that answer a tap: a segment thumb, the tab lens. */
  snappy: { damping: 1, response: 0.3 },
  /** A sheet let go with momentum: a touch of bounce, because a flick came before it. */
  fling: { damping: 0.8, response: 0.32 },
  /** Leaving: quick and clean. */
  exit: { damping: 1, response: 0.28 },
} satisfies Record<string, SpringParams>;

/**
 * Where a spring is `t` seconds after it starts `x0` away from its target with velocity `v0` (units per second).
 * Closed form, so a frame never drifts and a retarget can start from the exact presentation value.
 */
export function springAt(x0: number, v0: number, p: SpringParams, t: number): { x: number; v: number } {
  const w = (2 * Math.PI) / p.response;
  const z = p.damping;
  if (Math.abs(z - 1) < 1e-6) {
    const c = v0 + w * x0;
    const e = Math.exp(-w * t);
    return { x: e * (x0 + c * t), v: e * (v0 - w * c * t) };
  }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    const b = (v0 + z * w * x0) / wd;
    const e = Math.exp(-z * w * t);
    const cos = Math.cos(wd * t), sin = Math.sin(wd * t);
    return { x: e * (x0 * cos + b * sin), v: e * (v0 * cos - (x0 * wd + z * w * b) * sin) };
  }
  const s = Math.sqrt(z * z - 1);
  const r1 = -w * (z - s), r2 = -w * (z + s);
  const c2 = (v0 - r1 * x0) / (r2 - r1), c1 = x0 - c2;
  const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
  return { x: c1 * e1 + c2 * e2, v: r1 * c1 * e1 + r2 * c2 * e2 };
}

/**
 * How far a flick carries, from Apple's Designing Fluid Interfaces sample: velocity in units per second, and the
 * scroll view's deceleration (0.998 normal, 0.99 fast). Choose the snap point nearest to `position + project(v)`.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Past an edge, the element follows less the further it goes: real things slow before they stop. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot), o = Math.abs(overshoot);
  return sign * ((o * dimension * constant) / (dimension + constant * o));
}

/** The snap point nearest to `value`. */
export function nearest(value: number, points: number[]): number {
  return points.reduce((best, p) => (Math.abs(p - value) < Math.abs(best - value) ? p : best), points[0]);
}

/**
 * A finger's speed from its last few positions. Only the last 100 ms count, so a drag that paused before the release
 * hands over no velocity and a flick hands over all of it.
 */
export class VelocityTracker {
  private samples: { t: number; x: number }[] = [];
  add(x: number, t: number): void {
    this.samples.push({ t, x });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }
  /** Units per second at `now`. */
  velocity(now: number): number {
    const s = this.samples.filter((p) => now - p.t <= 100);
    if (s.length < 2) return 0;
    const a = s[0], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? (b.x - a.x) / dt : 0;
  }
  reset(): void { this.samples = []; }
}

/**
 * A spring's progress as a CSS `linear()` easing, for transitions nothing can grab (hover, a toggle knob): `points`
 * samples over the time it takes to settle, which is returned too as the duration to pair it with.
 */
export function springEasing(p: SpringParams, points = 40, precision = 0.001): { easing: string; seconds: number } {
  let seconds = 0;
  for (let t = 0; t < 5; t += 0.005) {
    const { x, v } = springAt(-1, 0, p, t);
    if (Math.abs(x) < precision && Math.abs(v) < precision * 10) { seconds = t; break; }
  }
  const stops: string[] = [];
  for (let i = 0; i <= points; i++) {
    const { x } = springAt(-1, 0, p, (seconds * i) / points);
    stops.push(String(Math.round((1 + x) * 1000) / 1000));
  }
  stops[stops.length - 1] = '1';
  return { easing: `linear(${stops.join(', ')})`, seconds: Math.round(seconds * 100) / 100 };
}

/** The system asks for less motion: springs jump and callers cross-fade instead. */
export const reducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * One animated value. `to` starts from the presentation value and keeps the current velocity, so retargeting mid-flight
 * never jumps or hits a wall; `set` pins it (1:1 tracking under a finger) and records the finger's velocity for the
 * hand-off. `onUpdate` is called every frame with the value; write it to a transform, never to React state.
 */
export class Spring {
  private from = 0;
  private v0 = 0;
  private target: number;
  private start = 0;
  private raf = 0;
  private params: SpringParams = SPRINGS.smooth;
  private rest: (() => void) | undefined;
  private current: number;
  private vel = 0;

  constructor(value: number, private readonly onUpdate: (value: number) => void, private readonly precision = 0.1) {
    this.current = value;
    this.target = value;
  }

  get value(): number { return this.current; }
  get velocity(): number { return this.vel; }
  get goal(): number { return this.target; }
  get moving(): boolean { return this.raf !== 0; }

  /** Pin to `value` now, stopping any motion. `velocity` is what a later `to` inherits. */
  set(value: number, velocity = 0): void {
    this.stop();
    this.current = value; this.target = value; this.vel = velocity;
    this.onUpdate(value);
  }

  to(target: number, opts: { velocity?: number; params?: SpringParams; onRest?: () => void } = {}): void {
    const now = performance.now();
    this.sample(now);
    this.from = this.current;
    this.v0 = opts.velocity ?? this.vel;
    this.target = target;
    this.start = now;
    this.params = opts.params ?? SPRINGS.smooth;
    this.rest = opts.onRest;
    if (reducedMotion()) { this.finish(); return; }
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf) { this.sample(performance.now()); cancelAnimationFrame(this.raf); this.raf = 0; }
    this.rest = undefined;
  }

  private sample(now: number): void {
    if (!this.raf) return;
    const { x, v } = springAt(this.from - this.target, this.v0, this.params, (now - this.start) / 1000);
    this.current = this.target + x; this.vel = v;
  }

  private finish(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0; this.current = this.target; this.vel = 0;
    this.onUpdate(this.target);
    const r = this.rest; this.rest = undefined; r?.();
  }

  private tick = (now: number): void => {
    const { x, v } = springAt(this.from - this.target, this.v0, this.params, Math.max(0, now - this.start) / 1000);
    if (Math.abs(x) < this.precision && Math.abs(v) < this.precision * 10) { this.finish(); return; }
    this.current = this.target + x; this.vel = v;
    this.onUpdate(this.current);
    this.raf = requestAnimationFrame(this.tick);
  };
}
