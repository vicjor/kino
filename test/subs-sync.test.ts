import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { speechFrames, cueFrames, bestShift, syncSubtitle, FRAME_MS, RATE } from '../server/subs/sync.ts';
import { killChildren } from '../server/lifecycle.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
/** A stand-in ffmpeg: a shell script, made executable. */
const stub = (name: string, body: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };
const VTT = 'WEBVTT\n\n00:00:01.500 --> 00:00:02.500\nHello\n';

test('speechFrames: loud frames are speech, quiet ones are not', () => {
  const n = RATE * FRAME_MS / 1000;
  const pcm = new Int16Array(n * 100);
  for (let f = 0; f < 100; f++) if (f >= 30 && f < 60) for (let i = 0; i < n; i++) pcm[f * n + i] = (i % 2 ? 1 : -1) * 8000;
  const s = speechFrames(pcm);
  assert.equal(s.length, 100);
  assert.equal(s.slice(30, 60).every((x) => x === 1), true);
  assert.equal(s.slice(0, 30).every((x) => x === 0), true);
});

test('cueFrames marks the frames a cue covers, relative to the window start', () => {
  const c = cueFrames([{ start: 1000, end: 1100, text: 'a' }, { start: 5000, end: 5040, text: 'b' }], 900, 300);
  assert.equal(c[5], 1); assert.equal(c[9], 1); assert.equal(c[10], 0); assert.equal(c[205], 1); assert.equal(c[206], 1); assert.equal(c[207], 0);
});

test('bestShift finds the delay that lines cues up with speech, in both directions', () => {
  const audio = new Uint8Array(500); for (let i = 100; i < 140; i++) audio[i] = 1; for (let i = 300; i < 330; i++) audio[i] = 1;
  const early = new Uint8Array(500); for (let i = 60; i < 100; i++) early[i] = 1; for (let i = 260; i < 290; i++) early[i] = 1;     // subtitles 40 frames early
  const late = new Uint8Array(500); for (let i = 125; i < 165; i++) late[i] = 1; for (let i = 325; i < 355; i++) late[i] = 1;      // 25 frames late
  assert.equal(bestShift(audio, early, 100).shift, 40);
  assert.equal(bestShift(audio, late, 100).shift, -25);
  assert.equal(bestShift(audio, audio, 100).score, 1);
});

// FFMPEG_BIN is set after the import on purpose: the binary is looked up per spawn (binPath), as playback does.
test('sync reads audio through the ffmpeg binPath picks at the time of the call', async () => {
  // 4 s of 8 kHz PCM, speech from 2 s to 3 s; the cue runs 1.5 s to 2.5 s, so half a second early.
  const js = `const r=${RATE},b=Buffer.alloc(r*8);for(let i=r*2;i<r*3;i++)b.writeInt16LE(i%2?8000:-8000,i*2);process.stdout.write(b)`;
  process.env.FFMPEG_BIN = stub('pcm-ffmpeg', `exec "${process.execPath}" -e '${js}'`);
  const r = await syncSubtitle(VTT, 'http://127.0.0.1:9/none', 2, { windowSec: 4, maxShiftSec: 1 });
  assert.deepEqual(r, { offsetMs: 500, score: 1 });
});

test('a sync still reading audio is killed by the shutdown, at once', async () => {
  process.env.FFMPEG_BIN = stub('slow-ffmpeg', 'exec sleep 30');
  const t0 = Date.now();
  const sync = syncSubtitle(VTT, 'http://127.0.0.1:9/none', 2, { windowSec: 4 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(killChildren(), 1);
  await assert.rejects(sync, /No audio read/);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(killChildren(), 0, 'nothing left to kill');
});

test('a subtitle with no cues, or none in the window, is a 422 with its reason, not a server failure', async () => {
  const is422 = (re: RegExp) => (e: unknown) => (e as { status?: number }).status === 422 && re.test((e as Error).message);
  await assert.rejects(syncSubtitle('WEBVTT\n\n', 'http://127.0.0.1:9/none', 2), is422(/^No cues in this subtitle$/));
  const js = `process.stdout.write(Buffer.alloc(${RATE * 8}))`;   // 4 s of silence
  process.env.FFMPEG_BIN = stub('quiet-ffmpeg', `exec "${process.execPath}" -e '${js}'`);
  const late = 'WEBVTT\n\n00:10:00.000 --> 00:10:02.000\nMuch later\n';
  await assert.rejects(syncSubtitle(late, 'http://127.0.0.1:9/none', 2, { windowSec: 4, maxShiftSec: 1 }), is422(/^No subtitles in this part of the film/));
});

test('a missing ffmpeg: the sync says it could not start', async () => {
  process.env.FFMPEG_BIN = path.join(tmp, 'no-such-ffmpeg');
  await assert.rejects(syncSubtitle(VTT, 'http://127.0.0.1:9/none', 2), /ffmpeg could not start: ENOENT \(not found\)/);
  assert.equal(killChildren(), 0, 'a child that never started is not kept');
});
