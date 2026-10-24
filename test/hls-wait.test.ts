import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { HlsSession } from '../server/media/hls.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
process.env.LOG_LEVEL = 'error';
(await import('../server/config.ts')).ensureDirs();
const hls = await import('../server/media/hls.ts');
const { WAIT } = hls;
const { default: express } = await import('express');
const { api } = await import('../server/routes/play.ts');
const { jsonErrors } = await import('../server/errors.ts');

// Stands in for ffmpeg: the first segment after $STUB_FIRST s, the second $STUB_EVERY s later, each renamed into place
// (temp_file) before the playlist that lists it, then idles. One process (no sh with a sleep child that a SIGKILL would
// orphan, holding the stderr pipe open).
const stub = path.join(DIR, 'stub-ffmpeg');
fs.writeFileSync(stub, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const last = process.argv.at(-1), dir = path.dirname(last);
let pl = '#EXTM3U\\n';
const put = (f) => {
  fs.writeFileSync(path.join(dir, f + '.tmp'), Buffer.alloc(1000)); fs.renameSync(path.join(dir, f + '.tmp'), path.join(dir, f));
  pl += '#EXTINF:4.000000,\\n' + f + '\\n'; fs.writeFileSync(last + '.tmp', pl); fs.renameSync(last + '.tmp', last);
};
setTimeout(() => { put('seg00000.ts'); setTimeout(() => put('seg00001.ts'), process.env.STUB_EVERY * 1000); }, process.env.STUB_FIRST * 1000);
setTimeout(() => {}, 60_000);
`, { mode: 0o755 });
process.env.FFMPEG_BIN = stub;
const stubAt = (first: number, every = 30) => { process.env.STUB_FIRST = String(first); process.env.STUB_EVERY = String(every); };

const app = express();
app.use('/api', api);
app.use(jsonErrors);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(async () => { hls.stopAll(); server.closeAllConnections(); server.close(); await new Promise((r) => setTimeout(r, 600)); fs.rmSync(DIR, { recursive: true, force: true }); });

let n = 0;
const opts = () => ({
  infoHash: `h${++n}`, fileIdx: 0, sourceUrl: 'http://127.0.0.1:9/none', startOffset: 0, owner: `wait-${n}`,
  decision: { mode: 'hls-transcode', videoCopy: false, audioCopy: false, segment: 'mpegts', audioIndex: 1 } as HlsSession['decision'],
  probe: { container: 'mkv', duration: 3600, audio: [], subs: [], video: { codec: 'h264', height: 1080 } },
});
/** WAIT.pollMs for one test: 60 s means only a file event or a state change can wake a waiter in time. */
const withPoll = async (ms: number, fn: () => Promise<void>) => { const was = WAIT.pollMs; WAIT.pollMs = ms; try { await fn(); } finally { WAIT.pollMs = was; } };
const NO_POLL = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ms from stop() to `p` settling, `ms` after the wait began. stop() wakes its waiters at once: well before the folder goes 500 ms later, whose file events would wake them too. */
const afterStop = async (s: HlsSession, p: Promise<unknown>, ms = 50) => { await sleep(ms); const t = Date.now(); hls.stop(s.id); await p; return Date.now() - t; };
const AT_ONCE = 300;
/** Folder watches and ref'd timers alive in this process. A closed handle leaves the list a loop turn later. */
const live = async () => { await sleep(30); const r = process.getActiveResourcesInfo(); return { watches: r.filter((x) => x === 'FSEventWrap').length, timers: r.filter((x) => x === 'Timeout').length }; };
const fds = () => fs.readdirSync('/dev/fd').length;

test('waitReady wakes as ffmpeg writes the playlist, not on a timer', () => withPoll(NO_POLL, async () => {
  stubAt(0.3);
  const s = hls.start(opts());
  assert.equal(s.state, 'starting');
  await hls.waitReady(s, 5000);   // a 503 here would mean only the poll could have woken it
  assert.equal(s.state, 'ready');
  hls.stop(s.id);
}));

test('waitFile: a segment is there the moment it is renamed into place, at once if it already is', () => withPoll(NO_POLL, async () => {
  stubAt(0.1, 0.4);
  const s = hls.start(opts());
  await hls.waitReady(s, 5000);
  assert.equal(await hls.waitFile(s, 'seg00000.ts', 0), true, 'already on disk');
  assert.equal(fs.existsSync(path.join(s.dir, 'seg00001.ts')), false);
  const t = Date.now();
  assert.equal(await hls.waitFile(s, 'seg00001.ts', 10_000), true);
  assert.ok(Date.now() - t < 3000, 'as it lands (0.4 s after the first), not at the deadline\'s last look');
  hls.stop(s.id);
}));

test('waitFile: false after the wait, and at once when the session stops', () => withPoll(NO_POLL, async () => {
  stubAt(0.1);
  const s = hls.start(opts());
  await hls.waitReady(s, 5000);
  assert.equal(await hls.waitFile(s, 'seg00009.ts', 100), false);
  assert.ok(await afterStop(s, hls.waitFile(s, 'seg00009.ts', 20_000).then((v) => assert.equal(v, false))) < AT_ONCE);
  assert.equal(await hls.waitFile(s, 'seg00009.ts', 20_000), false, 'a stopped session waits for nothing');
}));

test('waitReady: a stop rejects at once (410), a start that takes too long after the wait (503)', () => withPoll(NO_POLL, async () => {
  stubAt(30);
  const s = hls.start(opts());
  await assert.rejects(hls.waitReady(s, 100), (e: Error & { status?: number }) => e.status === 503 && /still starting/.test(e.message));
  assert.ok(await afterStop(s, assert.rejects(hls.waitReady(s, 20_000), (e: Error & { status?: number; code?: string }) => e.status === 410 && e.code === 'session-gone')) < AT_ONCE);
}));

test('a watch that misses events (FSEvents drops some): the poll still wakes the waiters, and the watch is closed after', async (ctx) => {
  let closed = 0;
  const silent = Object.assign(new EventEmitter(), { close: () => { closed++; } });
  ctx.mock.method(fs, 'watch', () => silent);
  await withPoll(20, async () => {
    stubAt(0.1, 0.2);
    const s = hls.start(opts());
    await hls.waitReady(s, 5000);
    assert.equal(closed, 1, 'nobody waits once it is ready');
    assert.equal(await hls.waitFile(s, 'seg00001.ts', 5000), true);
    assert.equal(closed, 2);
    hls.stop(s.id);
  });
});

test('a watch that cannot start (too many open files): the poll alone', async (ctx) => {
  ctx.mock.method(fs, 'watch', () => { throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }); });
  await withPoll(20, async () => {
    stubAt(0.1);
    const s = hls.start(opts());
    await hls.waitReady(s, 5000);
    hls.stop(s.id);
  });
});

// A stand-in ffprobe that takes half a second to find the keyframe at 20 s: a copy-mode seek is ready only once its start is measured.
const slowProbe = path.join(DIR, 'slow-ffprobe');
fs.writeFileSync(slowProbe, `#!/bin/sh\nsleep 0.5\necho '{"packets":[{"pts_time":"20.0","dts_time":"20.0","flags":"K__"}],"streams":[{"has_b_frames":0}]}'\n`, { mode: 0o755 });

test('copy seek: waitReady answers the moment the start is measured, with no file written after', () => withPoll(NO_POLL, async () => {
  process.env.FFPROBE_BIN = slowProbe;
  try {
    stubAt(0.1);
    const t = Date.now();
    const s = hls.start({ ...opts(), startOffset: 20,
      decision: { mode: 'hls-copy', videoCopy: true, audioCopy: true, segment: 'mpegts', audioIndex: 1 },
      probe: { container: 'mkv', startTime: 0, duration: 3600, audio: [], subs: [], video: { codec: 'h264' }, bframes: false } });
    await hls.waitReady(s, 10_000);   // after the last file event: only setState wakes it before the deadline's last look
    assert.ok(Date.now() - t < 3000, 'with the measure, not at the deadline');
    assert.equal(s.startOffset, 20);
    hls.stop(s.id);
  } finally { delete process.env.FFPROBE_BIN; }
}));

test('one folder watch for every waiting session, closed with the last waiter; a stop mid-wait leaks no watch, timer or fd', async () => {
  await sleep(600);   // the folder removals of the tests before
  const before = await live(); const fd0 = fds();
  assert.equal(before.watches, 0);
  stubAt(0.3, 30);
  const a = hls.start(opts()), b = hls.start(opts());
  assert.deepEqual(await live(), { watches: 1, timers: before.timers + 1 }, 'both starting: one watch, one poll');
  await Promise.all([hls.waitReady(a, 5000), hls.waitReady(b, 5000)]);
  assert.deepEqual(await live(), before, 'ready: nobody waits, nothing runs');
  stubAt(30);
  const c = hls.start(opts());
  const waits = [hls.waitFile(a, 'seg00001.ts', 20_000), hls.waitFile(b, 'seg00001.ts', 20_000), hls.waitReady(c, 20_000).catch((e) => e.status)];
  assert.deepEqual(await live(), { watches: 1, timers: before.timers + 4 }, 'one watch, one poll, three wait timers');
  const exits = [a, b, c].map((s) => once(s.proc!, 'exit'));
  for (const s of [a, b, c]) hls.stop(s.id);
  assert.deepEqual(await Promise.all(waits), [false, false, 410]);
  await Promise.all(exits);
  await sleep(600);   // stop() removes the folder after 500 ms
  assert.deepEqual(await live(), before, 'stopped: no watch, no poll');
  assert.equal(fds(), fd0, 'no fd left open');
});

test('GET a segment before it is written: served as it lands; of a stopped session: 404 at once, not after 20 s', () => withPoll(NO_POLL, async () => {
  stubAt(0.1, 0.5);
  const s = hls.start(opts());
  const pl = await fetch(`${base}/hls/${s.id}/index.m3u8`);
  assert.equal(pl.status, 200);
  assert.match(await pl.text(), /seg00000\.ts/);
  const seg = await fetch(`${base}/hls/${s.id}/seg00001.ts`);
  assert.equal(seg.status, 200);
  assert.equal((await seg.arrayBuffer()).byteLength, 1000);
  assert.ok(await afterStop(s, fetch(`${base}/hls/${s.id}/seg00009.ts`).then((r) => assert.equal(r.status, 404)), 100) < AT_ONCE);
  assert.equal((await fetch(`${base}/hls/${s.id}/seg00009.ts`)).status, 404, 'session gone');
}));
