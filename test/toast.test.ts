import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toast, toastMs, withToast, dismissToast, getStore, setStore } from '../client/lib/store.ts';

test('toastMs: notes keep their time, errors stay at least 6 s, long text stays long enough to read', () => {
  assert.equal(toastMs('Saved', 'info'), 3500);
  assert.equal(toastMs('Saved', 'info', 6000), 6000);
  assert.equal(toastMs('No peers', 'error'), 6000);
  assert.equal(toastMs('No peers', 'error', 2000), 6000, 'a short time asked for an error is raised to 6 s');
  assert.equal(toastMs('x'.repeat(200), 'error'), 11000);
  assert.equal(toastMs('x'.repeat(100), 'info'), 6000);
  assert.equal(toastMs('x'.repeat(5000), 'error'), 20000, 'reading time is capped');
  assert.equal(toastMs('x', 'info', 30000), 30000, 'an explicit longer time wins');
});

test('withToast: adds last, and the same text replaces the one already up', () => {
  const a = { id: 1, text: 'A', kind: 'info' as const };
  const b = { id: 2, text: 'B', kind: 'error' as const };
  assert.deepEqual(withToast([], a), [a]);
  assert.deepEqual(withToast([a], b), [a, b]);
  const a2 = { id: 3, text: 'A', kind: 'info' as const };
  assert.deepEqual(withToast([a, b], a2), [b, a2]);
});

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); setStore({ toasts: [] }); });
afterEach(() => { for (const t of getStore().toasts) dismissToast(t.id); mock.timers.reset(); });

test('toast: an error stays 6 s, then goes', () => {
  toast('Could not reach the TV', 'error');
  assert.equal(getStore().toasts.length, 1);
  mock.timers.tick(5999);
  assert.equal(getStore().toasts.length, 1);
  mock.timers.tick(1);
  assert.deepEqual(getStore().toasts, []);
});

test('toast: the same text twice shows once, and its time starts over', () => {
  toast('Could not reach the TV', 'error');
  mock.timers.tick(4000);
  toast('Could not reach the TV', 'error');
  toast('Saved');
  assert.deepEqual(getStore().toasts.map((t) => t.text), ['Could not reach the TV', 'Saved']);
  mock.timers.tick(3500);
  assert.deepEqual(getStore().toasts.map((t) => t.text), ['Could not reach the TV'], 'the first timer no longer runs');
  mock.timers.tick(2500);
  assert.deepEqual(getStore().toasts, []);
});

test('dismissToast: a tap takes it down at once and its timer is dropped', () => {
  toast('One', 'error');
  toast('Two');
  dismissToast(getStore().toasts[0].id);
  assert.deepEqual(getStore().toasts.map((t) => t.text), ['Two']);
  mock.timers.tick(10000);
  assert.deepEqual(getStore().toasts, []);
});
