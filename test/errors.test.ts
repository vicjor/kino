import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { httpError, statusOf, jsonErrors, apiNotFound, publicMessage, UNEXPECTED, isSafeKey, safeKey, codeOf } from '../server/errors.ts';

const router = express.Router();
router.post('/echo', (req, res) => { res.json(req.body); });
router.get('/http', () => { throw httpError(404, 'Nothing here'); });
router.get('/plain', () => { throw new Error('boom'); });
router.get('/plain-async', async () => { throw new Error('async boom'); });   // Express 5: a rejection reaches jsonErrors
router.get('/upstream', async () => { throw new Error('404 Not Found for https://upstream.example/meta/movie/tt1.json'); });
router.get('/ours-500', () => { throw httpError(500, 'Kino could not run ffprobe on this Mac (not found). See the server log.'); });
router.get('/ours-502', () => { throw httpError(502, 'The addon did not answer in time'); });
router.get('/hidden-500', () => { throw Object.assign(new Error('EACCES: permission denied, stat /Users/me/secret'), { status: 500, expose: false }); });
router.get('/late', (_req, res, next) => { res.write('partial'); next(new Error('mid-stream')); });
router.get('/coded', () => { throw httpError(507, 'Disk nearly full', 'disk-full'); });
router.get('/sys-code', () => { throw Object.assign(new Error('Kino could not open that file'), { status: 404, code: 'ENOENT' }); });
const app = express();
app.use(express.json({ limit: '1kb' }));
app.use('/api', router);
app.use('/api', apiNotFound);   // as server/index.ts mounts it
app.use(jsonErrors);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => { server.closeAllConnections(); server.close(); });

/** Run fn with stderr captured (errors are logged there), return what it wrote. */
async function stderrOf(fn: () => Promise<void>): Promise<string> {
  const w = process.stderr.write; let out = '';
  process.stderr.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof w;
  try { await fn(); } finally { process.stderr.write = w; }
  return out;
}

test('httpError carries its status; statusOf falls back to 500 for anything not an HTTP error status', () => {
  const e = httpError(400, 'Bad');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.status, e.message], [400, 'Bad']);
  assert.equal(statusOf(e), 400);
  assert.equal(statusOf({ statusCode: 413 }), 413);
  for (const x of [new Error('x'), null, undefined, 'str', { status: 200 }, { status: 'x' }, { status: 999 }]) assert.equal(statusOf(x), 500, String(x));
});

test('an error with a code answers it next to its words; a system error code (ENOENT) never leaves the server', async () => {
  const c = await fetch(`${base}/coded`);
  assert.deepEqual([c.status, await c.json()], [507, { error: 'Disk nearly full', code: 'disk-full' }]);
  const s = await fetch(`${base}/sys-code`);
  assert.deepEqual([s.status, await s.json()], [404, { error: 'Kino could not open that file' }]);
  assert.equal(httpError(400, 'Bad').code, undefined);
  assert.equal(codeOf(httpError(504, 'Slow', 'unreadable')), 'unreadable');
  for (const x of [new Error('x'), { code: 'ENOENT' }, { code: 'toString' }, { code: 7 }, null, 'no-peers']) assert.equal(codeOf(x), undefined, String(x));
});

test('a body the JSON parser refuses is a JSON 400, not an HTML page', async () => {
  const r = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
  assert.equal(r.status, 400);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await r.json(), { error: 'The request body is not valid JSON' });
  const big = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(2048) }) });
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'The request body is too large' });
});

test('thrown errors keep their status and message; a plain error is a 500 that says only that, its cause goes to the log', async () => {
  const h = await fetch(`${base}/http`);
  assert.deepEqual([h.status, await h.json()], [404, { error: 'Nothing here' }]);
  let p!: Response; let body: unknown;
  const err = await stderrOf(async () => { p = await fetch(`${base}/plain?x=1`); body = await p.json(); });
  assert.deepEqual([p.status, body], [500, { error: UNEXPECTED }]);
  assert.match(err, /"level":"error".*"method":"GET","path":"\/api\/plain","status":500,"err":"boom","stack":"Error: boom\\n\s+at /);
  let a!: Response; let abody: unknown;
  await stderrOf(async () => { a = await fetch(`${base}/plain-async`); abody = await a.json(); });
  assert.deepEqual([a.status, abody], [500, { error: UNEXPECTED }], 'a rejected async handler with no status is a JSON 500');
});

test('an upstream URL in a plain error never reaches the answer; errors that name their status keep their text', async () => {
  const cases: [string, number, string][] = [
    ['/upstream', 500, UNEXPECTED],
    ['/ours-500', 500, 'Kino could not run ffprobe on this Mac (not found). See the server log.'],
    ['/ours-502', 502, 'The addon did not answer in time'],
    ['/hidden-500', 500, UNEXPECTED],   // a library error marked expose: false
  ];
  for (const [p, status, error] of cases) {
    let r!: Response; let body: unknown;
    const log = await stderrOf(async () => { r = await fetch(base + p); body = await r.json(); });
    assert.deepEqual([r.status, body], [status, { error }], p);
    assert.match(log, /"level":"error"/, `${p} is logged as a failure`);
  }
  const log = await stderrOf(async () => { await (await fetch(`${base}/upstream`)).json(); });
  assert.match(log, /"err":"404 Not Found for https:\/\/upstream\.example\/meta\/movie\/tt1\.json"/, 'the log keeps the real cause');
});

test('publicMessage: the parser\'s words, an error\'s own text when it names a status, else the plain sentence', () => {
  const table: [unknown, string][] = [
    [Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 }), 'The request body is not valid JSON'],
    [httpError(400, 'fileIdx must be a whole number from 0'), 'fileIdx must be a whole number from 0'],
    [httpError(409, 'Embedded subtitles are available once the file has fully downloaded'), 'Embedded subtitles are available once the file has fully downloaded'],
    [Object.assign(new Error('Disk full'), { statusCode: 507 }), 'Disk full'],
    [new Error('no meta for movie/tt1'), UNEXPECTED],
    [Object.assign(new Error('status 200 is no error status'), { status: 200 }), UNEXPECTED],
    [Object.assign(new Error('stream not readable'), { status: 500, expose: false }), UNEXPECTED],
    ['a thrown string', UNEXPECTED],
    [null, UNEXPECTED],
  ];
  for (const [e, want] of table) assert.equal(publicMessage(e), want, String(e));
});

test('an /api path no route serves is a JSON 404 for any method, not an HTML page', async () => {
  for (const [method, p] of [['GET', '/nope'], ['POST', '/nope/deeper'], ['DELETE', '/echo'], ['GET', '']] as const) {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const body = await r.json() as { error: string };
    assert.equal(body.error, 'Kino could not find that. Reload the page to get the latest version.');
    assert.doesNotMatch(body.error, /Cannot|<|\/api/);
  }
});

test('an error after the response started ends the connection instead of throwing in the handler', async () => {
  await stderrOf(async () => {
    const r = await fetch(`${base}/late`).catch((e: unknown) => e);
    if (r instanceof Response) { assert.equal(r.status, 200); await r.text().catch(() => ''); }
  });
  const ok = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(await ok.json(), { a: 1 }, 'the server is still fine');
});

test('isSafeKey: no part of the key may be a name Object.prototype has', () => {
  for (const k of ['tt0111161', 'tt0944947:1:2', 'kitsu:1:3', 'magnet:abcdef:0', 'dlna:uuid-1']) assert.equal(isSafeKey(k), true, k);
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '__proto__:1:2', 'tt1:constructor', '', 'x'.repeat(513), 42, null, undefined, ['tt1'], { a: 1 }]) assert.equal(isSafeKey(k), false, String(k));
  assert.equal(safeKey('tt1', 'video id'), 'tt1');
  assert.throws(() => safeKey('__proto__', 'video id'), (e) => statusOf(e) === 400 && /video id/.test((e as Error).message));
});
