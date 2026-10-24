import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { springAt, project, rubberband, nearest, VelocityTracker, springEasing, SPRINGS } from '../client/lib/spring.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('springAt: starts where it is, at the speed it was going', () => {
  for (const p of [SPRINGS.smooth, SPRINGS.fling, { damping: 1.4, response: 0.3 }]) {
    const s = springAt(-120, 800, p, 0);
    close(s.x, -120); close(s.v, 800);
  }
});

test('springAt: settles on the target, critically damped never overshoots', () => {
  let min = Infinity;
  for (let t = 0; t <= 2; t += 0.01) min = Math.min(min, -springAt(-1, 0, SPRINGS.smooth, t).x);
  assert.ok(min >= -1e-9, 'never past the target');
  assert.ok(Math.abs(springAt(-1, 0, SPRINGS.smooth, 2).x) < 1e-4);
});

test('springAt: below 1 damping overshoots, and a quicker response gets there sooner', () => {
  const peak = Math.max(...Array.from({ length: 200 }, (_, i) => 1 + springAt(-1, 0, SPRINGS.fling, i / 200).x));
  assert.ok(peak > 1.001 && peak < 1.05, `small overshoot, got ${peak}`);
  assert.ok(Math.abs(springAt(-1, 0, SPRINGS.snappy, 0.2).x) < Math.abs(springAt(-1, 0, SPRINGS.smooth, 0.2).x));
});

test('springAt: velocity is the derivative of position', () => {
  for (const p of [SPRINGS.smooth, SPRINGS.fling, { damping: 1.6, response: 0.5 }]) {
    const t = 0.13, h = 1e-6;
    const dx = (springAt(-50, 300, p, t + h).x - springAt(-50, 300, p, t - h).x) / (2 * h);
    close(springAt(-50, 300, p, t).v, dx, 1e-3);
  }
});

test('project: Apple projection, normal and fast deceleration', () => {
  close(project(1000), 499);
  close(project(-1000, 0.99), -99);
  assert.equal(project(0), 0);
});

test('rubberband: follows almost 1:1 at first, never reaches the dimension', () => {
  assert.ok(rubberband(10, 800) > 5);
  assert.ok(rubberband(10_000, 800) < 800);
  close(rubberband(-40, 800), -rubberband(40, 800));
  assert.equal(rubberband(0, 800), 0);
});

test('nearest: the snap point closest to a projected value', () => {
  assert.equal(nearest(260, [0, 600]), 0);
  assert.equal(nearest(320, [0, 600]), 600);
  assert.equal(nearest(-50, [0, 600]), 0);
});

test('VelocityTracker: speed over the last 100 ms, nothing after a pause', () => {
  const v = new VelocityTracker();
  for (let t = 0; t <= 200; t += 16) v.add(t * 2, t);   // 2 px per ms
  close(v.velocity(200), 2000, 1);
  assert.equal(v.velocity(400), 0, 'held still before letting go');
  v.reset();
  assert.equal(v.velocity(0), 0);
});

test('springEasing: a CSS linear() from 0 to 1 and the time it takes to settle', () => {
  const e = springEasing(SPRINGS.smooth, 10);
  assert.match(e.easing, /^linear\(0, [\d., ]+, 1\)$/);
  assert.ok(e.seconds > 0.4 && e.seconds < 1);
});

test('global.css: the spring easings match the springs they claim to be', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'client', 'styles', 'global.css'), 'utf8');
  for (const [name, p, pts] of [['smooth', SPRINGS.smooth, 24], ['snappy', SPRINGS.snappy, 20], ['bouncy', { damping: 0.8, response: 0.4 }, 32]] as const) {
    const e = springEasing(p, pts);
    assert.ok(css.includes(`--spring-${name}: ${e.easing};`), `--spring-${name}`);
    assert.ok(css.includes(`--spring-${name}-dur: ${e.seconds}s;`), `--spring-${name}-dur`);
  }
});
