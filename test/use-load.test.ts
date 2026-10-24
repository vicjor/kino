import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStep, errorText, backOnline, latest, type LoadState } from '../client/lib/use-load.ts';

const S = (o: Partial<LoadState<number[]>> = {}): LoadState<number[]> => ({ data: null, error: '', loading: false, ...o });

test('loadStep: a load that works shows its data and clears the error', () => {
  const s = loadStep(loadStep(S({ error: 'Down' }), { type: 'start', clear: false }), { type: 'ok', data: [1] });
  assert.deepEqual(s, { data: [1], error: '', loading: false });
});

test('loadStep: a failed refresh keeps the last good data and says why', () => {
  let s = loadStep(S(), { type: 'start', clear: false });
  s = loadStep(s, { type: 'ok', data: [1, 2] });
  s = loadStep(s, { type: 'start', clear: false });
  assert.deepEqual(s, { data: [1, 2], error: '', loading: true }, 'the data stays up while it reloads');
  s = loadStep(s, { type: 'fail', error: 'Could not reach Kino.' });
  assert.deepEqual(s, { data: [1, 2], error: 'Could not reach Kino.', loading: false });
});

test('loadStep: reload keeps the error up while it tries, retry clears it first', () => {
  const failed = S({ error: 'Down' });
  assert.deepEqual(loadStep(failed, { type: 'start', clear: false }), { data: null, error: 'Down', loading: true });
  assert.deepEqual(loadStep(failed, { type: 'start', clear: true }), { data: null, error: '', loading: true });
});

test('loadStep: set edits the data in place, by value or from the current data, and leaves the rest', () => {
  const s = S({ data: [1, 2, 3], error: 'Down', loading: true });
  assert.deepEqual(loadStep(s, { type: 'set', data: [9] }), { data: [9], error: 'Down', loading: true });
  assert.deepEqual(loadStep(s, { type: 'set', data: (d) => d && d.filter((x) => x !== 2) }), { data: [1, 3], error: 'Down', loading: true });
  assert.deepEqual(loadStep(s, { type: 'set', data: null }).data, null);
  assert.deepEqual(loadStep(S(), { type: 'set', data: (d) => d && [...d, 1] }).data, null, 'nothing loaded yet: the updater sees null');
});

test('errorText: the error message, never empty', () => {
  assert.equal(errorText(new Error('Could not reach Kino.')), 'Could not reach Kino.');
  assert.equal(errorText('Wrong PIN'), 'Wrong PIN');
  for (const e of [new Error(''), '', null, undefined, 42, {}]) assert.equal(errorText(e), 'Could not load this.', String(e));
});

test('backOnline: only the step from offline to online after a failed load', () => {
  assert.equal(backOnline(false, true, true), true);
  assert.equal(backOnline(false, true, false), false, 'nothing failed: nothing to redo');
  assert.equal(backOnline(true, true, true), false, 'already online');
  assert.equal(backOnline(true, false, true), false, 'going offline');
  assert.equal(backOnline(false, false, true), false);
});

test('latest: only the newest load counts, and none once stopped', () => {
  const t = latest();
  const a = t.next(), b = t.next();
  assert.equal(t.counts(a), false, 'an older answer arriving late is dropped');
  assert.equal(t.counts(b), true);
  t.stop();
  assert.equal(t.counts(b), false, 'the screen went away');
  const u = latest();
  assert.equal(u.counts(u.next()), true, 'each mount has its own tickets');
});
