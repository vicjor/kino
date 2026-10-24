import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TtlCache, redact, fetchJson, fetchText, upstreamStatusOf } from '../server/http.ts';

test('TtlCache.wrap: concurrent misses for one key share one upstream call', async () => {
  const c = new TtlCache<number>(60_000);
  let calls = 0; let release!: (v: number) => void;
  const fn = () => { calls++; return new Promise<number>((r) => { release = r; }); };
  const a = c.wrap('k', fn), b = c.wrap('k', fn);
  await Promise.resolve();
  release(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  assert.equal(calls, 1);
  assert.equal(await c.wrap('k', fn), 7);   // now cached
  assert.equal(calls, 1);
  assert.equal(await c.wrap('other', async () => 8), 8);   // other keys are independent
});

test('TtlCache.wrap: a failure reaches every waiter, is not cached, and the next call retries', async () => {
  const c = new TtlCache<number>(60_000);
  let calls = 0;
  const fail = async () => { calls++; await Promise.resolve(); throw new Error('down'); };
  const res = await Promise.allSettled([c.wrap('k', fail), c.wrap('k', fail)]);
  assert.deepEqual(res.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls, 1);
  assert.equal(c.get('k'), undefined);
  assert.equal(await c.wrap('k', async () => { calls++; return 3; }), 3);
  assert.equal(calls, 2);
});

test('TtlCache.wrap: a synchronous throw does not leave a stuck entry', async () => {
  const c = new TtlCache<number>(60_000);
  await assert.rejects(c.wrap('k', () => { throw new Error('sync'); }), /sync/);
  assert.equal(await c.wrap('k', async () => 5), 5);
});

const settle = () => new Promise((r) => setImmediate(r));

test('TtlCache stale: past ttl the old value comes back at once and one call refreshes it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const c = new TtlCache<number>(1000, 500, { stale: 10_000 });
  await c.wrap('k', async () => 1);
  t.mock.timers.tick(1500);
  let calls = 0; let release!: (v: number) => void;
  const fn = () => { calls++; return new Promise<number>((r) => { release = r; }); };
  assert.equal(await c.wrap('k', fn), 1);   // not held up by the refresh
  assert.equal(await c.wrap('k', fn), 1);
  assert.equal(c.get('k'), 1);
  await settle();
  assert.equal(calls, 1);                   // one refresh for both
  release(2); await settle();
  assert.equal(await c.wrap('k', fn), 2);   // fresh again
  assert.equal(calls, 1);
});

test('TtlCache stale: a failed refresh keeps the old value, and the next try waits a minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const c = new TtlCache<number>(1000, 500, { stale: 3_600_000 });
  await c.wrap('k', async () => 1);
  t.mock.timers.tick(1500);
  let calls = 0;
  assert.equal(await c.wrap('k', async () => { calls++; throw new Error('down'); }), 1);
  await settle();
  assert.equal(calls, 1);
  assert.equal(c.get('k'), 1);
  t.mock.timers.tick(30_000);
  assert.equal(await c.wrap('k', async () => { calls++; return 3; }), 1);   // upstream left alone during an outage
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(30_000);
  assert.equal(await c.wrap('k', async () => { calls++; return 3; }), 1);   // a minute on: one more try
  await settle();
  assert.equal(calls, 2);
  assert.equal(await c.wrap('k', async () => { calls++; return 4; }), 3);
  assert.equal(calls, 2);
});

test('TtlCache stale: the wait after a failure is the retry option, and a new value starts clean', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const c = new TtlCache<number>(1000, 500, { stale: 3_600_000, retry: 5000 });
  await c.wrap('k', async () => 1);
  t.mock.timers.tick(1500);
  let calls = 0;
  const fail = async () => { calls++; throw new Error('down'); };
  await c.wrap('k', fail); await settle();
  t.mock.timers.tick(4999);
  await c.wrap('k', fail); await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await c.wrap('k', async () => { calls++; return 2; }); await settle();
  assert.equal(calls, 2);
  assert.equal(c.get('k'), 2);
  t.mock.timers.tick(1500);                 // stale again: the old wait does not carry over
  await c.wrap('k', fail); await settle();
  assert.equal(calls, 3);
});

test('TtlCache valid: an empty refresh never replaces a good value, and waits like a failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  type M = { meta?: { id: string } } | undefined;
  const c = new TtlCache<M>(1000, 500, { stale: 3_600_000, valid: (v) => !!v?.meta });
  const good = { meta: { id: 'tt1' } };
  await c.wrap('k', async () => good);
  let calls = 0;
  for (const empty of [{}, undefined, { meta: undefined }]) {
    t.mock.timers.tick(60_000);
    assert.equal(await c.wrap('k', async () => { calls++; return empty; }), good);
    await settle();
    assert.equal(c.get('k'), good, `kept after ${JSON.stringify(empty)}`);
  }
  assert.equal(calls, 3);
  assert.equal(await c.wrap('k', async () => { calls++; return {}; }), good);   // inside the wait: no call
  await settle();
  assert.equal(calls, 3);
  t.mock.timers.tick(60_000);
  const next = { meta: { id: 'tt2' } };
  await c.wrap('k', async () => { calls++; return next; }); await settle();
  assert.equal(c.get('k'), next);
});

test('TtlCache valid: a refused value on a miss reaches the caller but is not cached', async () => {
  const c = new TtlCache<{ metas?: string[] }>(60_000, 500, { valid: (v) => Array.isArray(v?.metas) });
  let calls = 0;
  assert.deepEqual(await c.wrap('k', async () => { calls++; return {}; }), {});
  assert.equal(c.get('k'), undefined);
  assert.deepEqual(await c.wrap('k', async () => { calls++; return { metas: [] }; }), { metas: [] });   // empty list is a real answer
  assert.deepEqual(c.get('k'), { metas: [] });
  assert.equal(calls, 2);
});

test('TtlCache valid: by default any value is cached', async () => {
  const c = new TtlCache<number | undefined>(60_000);
  assert.equal(await c.wrap('k', async () => undefined), undefined);
  assert.equal(await c.wrap('z', async () => 0), 0);
  assert.equal(await c.wrap('z', async () => 9), 0);
});

test('TtlCache stale: the value is dropped once past ttl plus stale, and without stale at ttl', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const c = new TtlCache<number>(1000, 500, { stale: 10_000 });
  const plain = new TtlCache<number>(1000);
  await c.wrap('k', async () => 1); await plain.wrap('k', async () => 1);
  t.mock.timers.tick(1001);
  assert.equal(c.get('k'), 1);
  assert.equal(plain.get('k'), undefined);
  t.mock.timers.tick(10_000);
  assert.equal(c.get('k'), undefined);
  await assert.rejects(c.wrap('k', async () => { throw new Error('down'); }), /down/);   // nothing left to serve
  assert.equal(await c.wrap('k', async () => 5), 5);
});

test('TtlCache.set: writing an existing key at capacity evicts nothing', () => {
  const c = new TtlCache<number>(60_000, 2);
  c.set('a', 1); c.set('b', 2); c.set('a', 3);
  assert.equal(c.get('a'), 3); assert.equal(c.get('b'), 2);
  c.set('c', 4);   // evicts the oldest write, b
  assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 3); assert.equal(c.get('c'), 4);
});

test('redact masks key-like query values and passwords, leaves the rest readable', () => {
  assert.equal(redact('https://api.themoviedb.org/3/movie/1/external_ids?api_key=abc123'), 'https://api.themoviedb.org/3/movie/1/external_ids?api_key=***');
  assert.equal(redact('https://www.omdbapi.com/?i=tt1&apikey=S3cr3t'), 'https://www.omdbapi.com/?i=tt1&apikey=***');
  assert.equal(redact('https://x.org/a?token=t&page=2&key=k#frag'), 'https://x.org/a?token=***&page=2&key=***#frag');
  assert.equal(redact('https://x.org/a?API_KEY=A&Api-Key=B&access_token=C'), 'https://x.org/a?API_KEY=***&Api-Key=***&access_token=***');
  assert.equal(redact('https://user:hunter2@x.org/a'), 'https://user:***@x.org/a');
  assert.equal(redact('https://x.org/keys/1?monkey=1&keyword=2&q=api_key'), 'https://x.org/keys/1?monkey=1&keyword=2&q=api_key');
  assert.equal(redact('not a url ?key=v'), 'not a url ?key=***');
});

/** Run fn with stderr captured (warnings are logged there), return what it wrote. */
async function stderrOf(fn: () => Promise<void>): Promise<string> {
  const w = process.stderr.write; let out = '';
  process.stderr.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof w;
  try { await fn(); } finally { process.stderr.write = w; }
  return out;
}

test('fetch errors never carry the key, and carry the upstream status for code to read', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('no', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;
  try {
    await assert.rejects(fetchJson('https://api.example.org/x?api_key=SECRET1'), (e: Error) => !e.message.includes('SECRET1') && e.message.includes('api_key=***')
      && upstreamStatusOf(e) === 401 && (e as { status?: number }).status === undefined);
  } finally { globalThis.fetch = real; }
  // fetchText goes through net-guard, not fetch: a local server that says no. Its 502 is shown, so it names no URL; the log does, redacted.
  const srv = http.createServer((_q, res) => { res.statusCode = 401; res.end('no'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/x?apikey=SECRET2`;
    const log = await stderrOf(() => assert.rejects(fetchText(url, 5000, { allowPrivate: true, what: 'subtitle' }), (e: Error) =>
      e.message === 'The subtitle could not be downloaded (its server answered 401)' && (e as { status?: number }).status === 502 && upstreamStatusOf(e) === 401));
    assert.match(log, /"msg":"download failed".*"url":"http:\/\/127\.0\.0\.1:\d+\/x\?apikey=\*\*\*"/);
    assert.ok(!log.includes('SECRET2'));
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('upstreamStatusOf: only a number fetchJson or fetchText put there', () => {
  assert.equal(upstreamStatusOf(Object.assign(new Error('x'), { upstreamStatus: 404 })), 404);
  for (const e of [new Error('404 Not Found for https://x.example/a'), Object.assign(new Error('x'), { status: 404 }), Object.assign(new Error('x'), { upstreamStatus: '404' }), null, undefined, '404']) {
    assert.equal(upstreamStatusOf(e), undefined, String(e));
  }
});
