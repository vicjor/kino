import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HlsSession } from '../server/media/hls.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
process.env.LOG_LEVEL = 'warn';   // before config.ts loads: it reads the environment once
(await import('../server/config.ts')).ensureDirs();
const hls = await import('../server/media/hls.ts');
const { segIndex, aheadOf, capSec, shouldHold, AHEAD, NUDGE, served, throttleAll } = hls;
const { getState } = await import('../server/store.ts');
after(() => { hls.stopAll(); fs.rmSync(DIR, { recursive: true, force: true }); });

const MB = 1024 ** 2;
/** A playlist of `n` segments of `dur` seconds, as ffmpeg writes it (mpegts or fmp4 names). */
const playlist = (n: number, dur = 4, ext = 'ts') => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:EVENT',
  ...(ext === 'm4s' ? ['#EXT-X-MAP:URI="init.mp4"'] : []),
  ...Array.from({ length: n }, (_, i) => `#EXTINF:${dur.toFixed(6)},\nseg${String(i).padStart(5, '0')}.${ext}`)].join('\n') + '\n';

test('segIndex: segment files only', () => {
  assert.equal(segIndex('seg00042.ts'), 42);
  assert.equal(segIndex('seg00000.m4s'), 0);
  assert.equal(segIndex('seg123456.ts'), 123456, 'past five digits too');
  for (const f of ['index.m3u8', 'init.mp4', 'seg00001.ts.tmp', 'xseg00001.ts', 'seg.ts']) assert.equal(segIndex(f), undefined, f);
});

test('aheadOf: seconds and bytes on disk past the furthest segment asked for (stub segments)', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'segs-'));
  fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist(10, 4, 'm4s'));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `seg${String(i).padStart(5, '0')}.m4s`), Buffer.alloc(1000 + i));
  fs.writeFileSync(path.join(dir, 'init.mp4'), Buffer.alloc(5000));
  const pl = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
  const size = (f: string) => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } };
  assert.deepEqual(aheadOf(pl, 6, size), { sec: 12, bytes: 1007 + 1008 + 1009 });
  assert.deepEqual(aheadOf(pl, -1, size), { sec: 40, bytes: 10 * 1000 + 45 }, 'nothing asked yet: all of it, init.mp4 not counted');
  assert.deepEqual(aheadOf(pl, 9, size), { sec: 0, bytes: 0 }, 'at the edge');
  assert.deepEqual(aheadOf(pl, 50, size), { sec: 0, bytes: 0 }, 'past the edge (a player waiting on the next segment)');
  assert.equal(aheadOf('#EXTM3U\r\n#EXTINF:3.5,\r\nseg00000.ts\r\n#EXTINF:2.25,\r\nseg00001.ts\r\n', -1, () => 0).sec, 5.75, 'CRLF and short segments');
});

test('capSec: ten minutes, or 2 GB at the bitrate ahead, never under two minutes; two minutes with the disk short', () => {
  const at = (min: number, mb = 0) => ({ sec: min * 60, bytes: mb * MB });
  assert.equal(AHEAD.maxSec, 600); assert.equal(AHEAD.minSec, 120); assert.equal(AHEAD.maxBytes, 2048 * MB);
  assert.equal(capSec(at(5), false), 600, 'nothing on disk yet (empty stub segments): the time cap');
  assert.equal(capSec(at(5, 500), false), 600, 'a transcode: 500 MB in five minutes reaches 2 GB well past ten');
  assert.equal(capSec(at(4, 2048), false), 240, 'a remux: 2 GB in four minutes, so four minutes');
  assert.equal(capSec(at(1, 50_000), false), 120, 'however big, two minutes');
  assert.equal(capSec(at(5, 500), true), 120, 'disk short');
});

test('shouldHold: held over the cap, let go 30 s under it', () => {
  const at = (sec: number, mb = 0) => ({ sec, bytes: mb * MB });
  assert.equal(AHEAD.release, 30);
  assert.equal(shouldHold(at(600), false, false), false, 'at the cap');
  assert.equal(shouldHold(at(604), false, false), true);
  assert.equal(shouldHold(at(580), true, false), true, 'held: stays held above 570 s');
  assert.equal(shouldHold(at(566), true, false), false, 'let go about one segment later');
  assert.equal(shouldHold(at(180, 2100), false, false), true, 'a remux: over 2 GB ahead holds at three minutes');
  assert.equal(shouldHold(at(180, 1800), true, false), true, 'held: stays held while 30 s more would pass 2 GB');
  assert.equal(shouldHold(at(180, 1700), true, false), false);
  assert.equal(shouldHold(at(114, 50_000), false, false), false, 'however big, two minutes ahead is kept');
  assert.equal(shouldHold(at(124), false, true), true, 'disk short: over two minutes holds');
  assert.equal(shouldHold(at(100), true, true), true);
  assert.equal(shouldHold(at(88), true, true), false, 'disk short and held: let go under 90 s');
  assert.equal(shouldHold(at(0), false, true), false);
});

// Stands in for ffmpeg: writes a playlist of $STUB_SEGS 4 s segments of $STUB_BYTES each into the folder of its last argument, then idles.
// One node process, like ffmpeg: a sh stub that wrote, then ran `exec sleep`, could take a park's SIGSTOP mid exec (the session is
// ready the moment its playlist lands), and ps lists no state for a process stopped there.
const stub = path.join(DIR, 'stub-ffmpeg');
fs.writeFileSync(stub, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const last = process.argv.at(-1), dir = path.dirname(last);
let pl = '#EXTM3U\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n';
for (let i = 0; i < +process.env.STUB_SEGS; i++) {
  const f = 'seg' + String(i).padStart(5, '0') + '.ts';
  fs.writeFileSync(path.join(dir, f), Buffer.alloc(+process.env.STUB_BYTES));
  pl += '#EXTINF:4.000000,\\n' + f + '\\n';
}
fs.writeFileSync(path.join(dir, 'tmp.m3u8'), pl); fs.renameSync(path.join(dir, 'tmp.m3u8'), last);
setTimeout(() => {}, 30_000);
`, { mode: 0o755 });
process.env.FFMPEG_BIN = stub;
process.env.STUB_SEGS = '200';   // 800 s
process.env.STUB_BYTES = '0';

const startOpts = (owner: string, startOffset = 0) => ({
  infoHash: 'h', fileIdx: 0, sourceUrl: 'http://127.0.0.1:9/none', startOffset, owner,
  decision: { mode: 'hls-transcode', videoCopy: false, audioCopy: false, segment: 'mpegts', audioIndex: 1 } as HlsSession['decision'],
  probe: { container: 'mkv', duration: 3600, audio: [], subs: [], video: { codec: 'hevc', height: 1080 } },
});
/** ps state of the process: T when stopped. */
const stopped = (s: HlsSession) => execFileSync('ps', ['-o', 'stat=', '-p', String(s.proc!.pid)]).toString().trim().startsWith('T');
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(ok(), what); };

test('throttle: ffmpeg is held far ahead of the furthest segment asked for and let go as the player comes closer', async () => {
  const s = hls.start(startOpts('throttle-1'));
  await hls.waitReady(s, 5000);
  throttleAll();
  assert.equal(s.held, false, 'nobody has asked for a segment: never held, the playhead is unknown');
  served(s, 'index.m3u8'); served(s, 'init.mp4');
  assert.equal(s.seg, undefined, 'the playlist and init segment say nothing about the playhead');
  served(s, 'seg00010.ts');   // 189 segments, 756 s ahead
  assert.equal(s.held, true);
  await until(() => stopped(s), 'SIGSTOP landed');
  served(s, 'seg00003.ts');   // a rewind: the furthest stands
  assert.equal(s.seg, 10);
  served(s, 'seg00055.ts');   // 576 s ahead: above 570, still held
  assert.equal(s.held, true);
  served(s, 'seg00057.ts');   // 568 s ahead
  assert.equal(s.held, false);
  await until(() => !stopped(s), 'SIGCONT landed');
  served(s, 'seg00030.ts'); throttleAll();
  assert.equal(s.held, false, 'the furthest ask counts, not the latest');
  hls.stop(s.id);
});

test('throttle: with the disk short, two minutes ahead is the cap', async () => {
  const s = hls.start(startOpts('throttle-2'));
  await hls.waitReady(s, 5000);
  const min = getState().settings.minFreeBytes;
  try {
    served(s, 'seg00150.ts');   // 196 s ahead
    assert.equal(s.held, false, 'room on disk');
    getState().settings.minFreeBytes = Number.MAX_SAFE_INTEGER;
    throttleAll();
    assert.equal(s.held, true, 'the timer holds it once the disk runs short');
    await until(() => stopped(s), 'SIGSTOP landed');
    served(s, 'seg00170.ts');   // 116 s ahead: under the cap, over the 90 s let go
    assert.equal(s.held, true);
    served(s, 'seg00177.ts');   // 88 s ahead
    assert.equal(s.held, false);
    await until(() => !stopped(s), 'SIGCONT landed');
  } finally { getState().settings.minFreeBytes = min; hls.stop(s.id); }
});

test('throttle and park: a held session stays frozen when woken, until its player asks near the edge', async () => {
  const a = hls.start(startOpts('throttle-3'));
  await hls.waitReady(a, 5000);
  served(a, 'seg00005.ts');
  assert.equal(a.held, true);
  const b = hls.start(startOpts('throttle-3', 1500));   // a seek far ahead parks the first
  assert.equal(a.parked, true);
  await hls.waitReady(b, 5000);
  assert.equal(hls.seek(b, 100), a, 'a rewind into it switches back');
  assert.equal(a.parked, false);
  assert.equal(b.parked, true);
  await until(() => stopped(b), 'the parked one is frozen');
  assert.ok(stopped(a), 'woken but still held: no SIGCONT yet');
  served(a, 'seg00150.ts');
  assert.equal(a.held, false);
  await until(() => !stopped(a), 'let go');
  hls.stop(a.id); hls.stop(b.id);
});

test('throttle: the bytes cap reads segment sizes on disk; an ask past the edge lets go at once', async () => {
  const max = AHEAD.maxBytes;
  process.env.STUB_BYTES = '1024';
  AHEAD.maxBytes = 100 * 1024;   // 100 segments of 1 KB: 400 s at this bitrate
  try {
    const s = hls.start(startOpts('throttle-5'));
    await hls.waitReady(s, 5000);
    served(s, 'seg00050.ts');   // 596 s, 149 KB ahead: over the bytes cap only
    assert.equal(s.held, true);
    await until(() => stopped(s), 'SIGSTOP landed');
    served(s, 'seg00100.ts');   // 396 s, 99 KB ahead: under the cap, over the let go
    assert.equal(s.held, true);
    served(s, 'seg00250.ts');   // a player waiting past the edge
    assert.equal(s.held, false);
    await until(() => !stopped(s), 'SIGCONT landed');
    hls.stop(s.id);
  } finally { AHEAD.maxBytes = max; process.env.STUB_BYTES = '0'; }
});

test('nudge: a frozen VideoToolbox ffmpeg runs a moment every so often, any other stays frozen', async () => {
  const { everyMs, runMs } = NUDGE;
  NUDGE.runMs = 400;
  try {
    const a = hls.start(startOpts('nudge-1')), b = hls.start(startOpts('nudge-2'));
    await hls.waitReady(a, 5000); await hls.waitReady(b, 5000);
    a.hw = true;   // as if this ffmpeg encoded on VideoToolbox
    served(a, 'seg00010.ts'); served(b, 'seg00010.ts');
    await until(() => stopped(a) && stopped(b), 'both held');
    throttleAll();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(stopped(a), 'not before everyMs');
    NUDGE.everyMs = 0;
    throttleAll();
    await until(() => !stopped(a), 'the hw one runs a moment');
    assert.ok(stopped(b), 'the other stays frozen');
    assert.equal(a.held, true, 'still held');
    await until(() => stopped(a), 'then it is frozen again');
    served(a, 'seg00195.ts');   // let go during or after a nudge: running for good
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!stopped(a));
    hls.stop(a.id); hls.stop(b.id);
  } finally { NUDGE.everyMs = everyMs; NUDGE.runMs = runMs; }
});

test('throttle: a session that has finished writing is never held', async () => {
  const quick = path.join(DIR, 'quick-ffmpeg');
  fs.writeFileSync(quick, '#!/bin/sh\nfor a; do last=$a; done\nprintf \'#EXTM3U\\n#EXTINF:4,\\nseg00000.ts\\n#EXT-X-ENDLIST\\n\' > "$last"\n', { mode: 0o755 });
  process.env.FFMPEG_BIN = quick;
  try {
    const s = hls.start(startOpts('throttle-4'));
    await until(() => s.state === 'ended', 'ended');
    served(s, 'seg00000.ts');
    assert.equal(s.held, false);
    hls.stop(s.id);
  } finally { process.env.FFMPEG_BIN = stub; }
});
