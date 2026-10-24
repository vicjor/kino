import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// client/lib/sse.ts: one EventSource for the whole app, typed listeners on it, kept across reconnects.

type Handler = (e: { data: string }) => void;
class FakeSource {
  static all: FakeSource[] = [];
  handlers = new Map<string, Handler[]>();
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSource.all.push(this); }
  addEventListener(name: string, h: Handler) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), h]); }
  close() { this.closed = true; }
  fire(name: string, data: unknown) { for (const h of this.handlers.get(name) ?? []) h({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}
(globalThis as { EventSource?: unknown }).EventSource = FakeSource;
const last = () => FakeSource.all[FakeSource.all.length - 1];

const { onSse, startSse } = await import('../client/lib/sse.ts');
const { getStore } = await import('../client/lib/store.ts');

// One file, one module state: the tests run in order and build on each other.
const early: unknown[] = [];
const stopEarly = onSse('hls.state', (st) => early.push(st));

test('startSse opens one connection, and a second call opens no other', () => {
  startSse(); startSse();
  assert.equal(FakeSource.all.length, 1);
  assert.equal(last().url, '/api/events');
});

test('onSse before startSse still hears its event: a deep link mounts the player before App connects', () => {
  last().fire('hls.state', { sessionId: 'a', state: 'error', error: 'x' });
  assert.deepEqual(early, [{ sessionId: 'a', state: 'error', error: 'x' }]);
});

test('the store\'s own events still land in the store', () => {
  last().fire('cast.status', { active: true, title: 'Film' });
  assert.equal(getStore().cast.title, 'Film');
});

test('every listener of an event hears it once; one that stops hears nothing more', () => {
  const a: unknown[] = []; const b: unknown[] = [];
  const stopA = onSse('disk', (d) => a.push(d));
  onSse('disk', (d) => b.push(d));
  last().fire('disk', { freeBytes: 1 });
  stopA();
  last().fire('disk', { freeBytes: 2 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
});

test('a payload that is not JSON reaches nobody, and a listener that throws does not stop the next one', () => {
  const got: unknown[] = [];
  onSse('downloads', () => { throw new Error('boom'); });
  onSse('downloads', (d) => got.push(d));
  last().fire('downloads', 'not json');
  last().fire('downloads', []);
  assert.deepEqual(got, [[]]);
});

test('after an error the app reconnects, and every listener carries over to the new connection', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = last();
    first.onerror?.();
    assert.equal(first.closed, true);
    assert.equal(getStore().online, false);
    mock.timers.tick(1000);
    const second = last();
    assert.notEqual(second, first);
    second.onopen?.();
    assert.equal(getStore().online, true);
    second.fire('hls.state', { sessionId: 'b', state: 'error' });
    assert.equal(early.length, 2);
    stopEarly();
    second.fire('hls.state', { sessionId: 'c', state: 'error' });
    assert.equal(early.length, 2, 'stopped');
  } finally { mock.timers.reset(); }
});
