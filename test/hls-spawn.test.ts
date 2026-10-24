import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { HlsSession } from '../server/media/hls.ts';
import { wrongCpuBinary, notMac } from './wrong-cpu.ts';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = tmp;
const hls = await import('../server/media/hls.ts');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
/** Stands in for an ffmpeg that runs and never writes a segment. */
const slow = path.join(tmp, 'slow-ffmpeg');
fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });

// waitReady wakes on the session's state change, not on a timer: the failure tests mock every timer and never tick one,
// so "at once" means with no timer run at all.
const TIMERS = { apis: ['setTimeout', 'setInterval'] } as const;

const opts = (hdr = false) => ({
  infoHash: 'h', fileIdx: 0, sourceUrl: 'http://127.0.0.1:9/none', startOffset: 0,
  decision: { mode: 'hls-transcode', videoCopy: false, audioCopy: false, segment: 'mpegts', audioIndex: 1 } as HlsSession['decision'],
  probe: { container: 'mkv', duration: 100, audio: [], subs: [], video: { codec: 'hevc', height: 2160 }, hdr },
});

test('missing ffmpeg binary: the session errors and waitReady rejects at once', async (ctx) => {
  ctx.mock.timers.enable(TIMERS);
  process.env.FFMPEG_BIN = path.join(tmp, 'no-such-ffmpeg');   // after import: the path is read per spawn
  const s = hls.start(opts());
  const rejected = assert.rejects(hls.waitReady(s, 10_000), (e: Error & { code?: string }) => /ffmpeg could not start: ENOENT/.test(e.message) && e.code === 'tool-broken');
  await once(s.proc!, 'error');   // the session's own listener came first
  assert.equal(s.state, 'error');
  assert.equal(s.errorCode, 'tool-broken', 'the player says this Mac cannot convert, not that the file is bad');
  await rejected;
  hls.stop(s.id);
});

test('ffmpeg that is not executable: says why, at once', async (ctx) => {
  ctx.mock.timers.enable(TIMERS);
  const plain = path.join(tmp, 'plain-ffmpeg'); fs.writeFileSync(plain, 'not a program', { mode: 0o644 });
  process.env.FFMPEG_BIN = plain;
  const s = hls.start(opts());
  const rejected = assert.rejects(hls.waitReady(s, 10_000), /ffmpeg could not start: EACCES \(not executable\)/);
  await once(s.proc!, 'error');
  await rejected;
  hls.stop(s.id);
});

test('ffmpeg for another CPU (no Rosetta): spawn throws, the session still errors with the reason', { skip: notMac }, async () => {
  process.env.FFMPEG_BIN = wrongCpuBinary(tmp, 'wrong-cpu-ffmpeg');
  const s = hls.start(opts());
  await assert.rejects(hls.waitReady(s, 10_000), /ffmpeg could not start: EBADARCH \(bad CPU type\)/);
  assert.equal(s.proc, undefined);
  hls.stop(s.id);
});

test('ffmpeg killed from outside: an error, not a silent stall or a fallback encode', async (ctx) => {
  ctx.mock.timers.enable(TIMERS);
  process.env.FFMPEG_BIN = slow;
  const s = hls.start(opts(true));
  const proc = s.proc!;
  await once(proc, 'spawn');
  const rejected = assert.rejects(hls.waitReady(s, 10_000), (e: Error & { code?: string }) => /ffmpeg was killed \(SIGKILL\)/.test(e.message) && e.code === 'transcode-failed');
  proc.kill('SIGKILL');
  await once(proc, 'exit');
  await rejected;
  assert.equal(s.triedNoTonemap, undefined, 'no retry without tonemap');
  assert.equal(s.proc, proc, 'no second ffmpeg');
  hls.stop(s.id);
});

test('stop() kills quietly: the session is gone, no error recorded', async () => {
  process.env.FFMPEG_BIN = slow;
  const s = hls.start(opts());
  const proc = s.proc!;
  hls.stop(s.id);
  await new Promise((r) => proc.once('exit', r));
  assert.equal(s.state, 'starting');
  assert.equal(s.error, undefined);
});

test('stopAll (shutdown) ends a parked, SIGSTOPped ffmpeg as well as the running one', async () => {
  process.env.FFMPEG_BIN = slow;
  const first = hls.start({ ...opts(), owner: 'shutdown-test' });
  fs.writeFileSync(path.join(first.dir, hls.playlistName()), '#EXTM3U\n#EXTINF:4.0,\nseg00000.ts\n');   // its first segment is out
  await hls.waitReady(first, 5000);
  const second = hls.start({ ...opts(), owner: 'shutdown-test', startOffset: 600 });   // a seek ahead parks the first
  assert.equal(first.parked, true);
  const procs = [first.proc!, second.proc!];
  const exits = procs.map((p) => new Promise<NodeJS.Signals | null>((r) => p.once('exit', (_c, sig) => r(sig))));
  hls.stopAll();
  assert.deepEqual(await Promise.all(exits), ['SIGKILL', 'SIGKILL']);
  assert.equal(hls.active().length, 0);
});
