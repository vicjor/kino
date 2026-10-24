import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../server/cast/timeout.ts';

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('withTimeout passes a value or an error through', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, 'answer'), 42);
  await assert.rejects(withTimeout(Promise.reject(new Error('Load failed')), 1000, 'load'), { message: 'Load failed' });
});

test('withTimeout rejects with the label once the time is up', async () => {
  const never = new Promise<never>(() => {});
  await assert.rejects(withTimeout(never, 20, 'Chromecast pause'), { message: 'Chromecast pause timed out after 0.02 s' });
  await assert.rejects(withTimeout(never, 150, 'Living stop'), /^Error: Living stop timed out after 0\.15 s$/);
});

test('withTimeout clears its timer when the promise settles first', async () => {
  const before = timers();
  await withTimeout(Promise.resolve('ok'), 60_000, 'fast');
  await withTimeout(Promise.reject(new Error('no')), 60_000, 'fast').catch(() => undefined);
  assert.equal(timers(), before);
});

test('withTimeout swallows a late rejection after the timeout', async () => {
  let fail!: (e: Error) => void;
  const late = new Promise<void>((_, rej) => { fail = rej; });
  await assert.rejects(withTimeout(late, 10, 'late'), /late timed out/);
  fail(new Error('socket closed'));   // must not surface as an unhandled rejection
  await new Promise((r) => setImmediate(r));
});
