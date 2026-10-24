import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import type { HlsSession } from '../server/media/hls.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const hls = await import('../server/media/hls.ts');
const { reapable, diskVictims } = hls;
const { getState } = await import('../server/store.ts');
const { addClient } = await import('../server/events.ts');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const MIN = 60_000;
const now = 60 * MIN;
const s = (id: string, idleMin: number, more: Partial<HlsSession> = {}): HlsSession =>
  ({ id, lastAccess: now - idleMin * MIN, owner: 'browser-1', state: 'ready', ...more }) as HlsSession;
const ids = (list: HlsSession[]) => list.map((x) => x.id).sort();

test('idle sessions reap after five minutes, busy ones stay', () => {
  assert.deepEqual(ids(reapable([s('idle', 6), s('busy', 1), s('edge', 5)], now, () => false)), ['idle']);
});

test('the session casting now stays however long the TV is paused, any other cast session reaps', () => {
  const casting = s('casting', 90, { owner: 'cast' });
  const dropped = s('dropped', 6, { owner: 'cast' });   // left running by a path that never called stop
  const fresh = s('fresh', 0.5, { owner: 'cast' });     // a start still waiting for its first segment
  assert.deepEqual(ids(reapable([casting, dropped, fresh], now, (x) => x.id === 'casting')), ['dropped']);
});

test('a parked session reaps when idle even if keep names it', () => {
  assert.deepEqual(ids(reapable([s('parked', 6, { owner: 'cast', parked: true })], now, () => true)), ['parked']);
  assert.deepEqual(ids(reapable([s('parked', 2, { owner: 'cast', parked: true })], now, () => false)), []);
});

const GB = 1024 ** 3;
const order = (list: HlsSession[]) => list.map((x) => x.id);

test('disk short: parked sessions first, oldest first, then idle ones, until enough is freed', () => {
  const list = [s('watching', 0.2), s('idle-new', 2.5), s('parked-new', 0.5, { parked: true }), s('idle-old', 4), s('parked-old', 3, { parked: true })];
  const size = () => 1 * GB;
  assert.deepEqual(order(diskVictims(list, now, 0.5 * GB, () => false, size)), ['parked-old']);
  assert.deepEqual(order(diskVictims(list, now, 2 * GB, () => false, size)), ['parked-old', 'parked-new']);
  assert.deepEqual(order(diskVictims(list, now, 3.5 * GB, () => false, size)), ['parked-old', 'parked-new', 'idle-old', 'idle-new']);
  assert.deepEqual(order(diskVictims(list, now, 100 * GB, () => false, size)), ['parked-old', 'parked-new', 'idle-old', 'idle-new'], 'never anyone watching');
  assert.deepEqual(diskVictims(list, now, 0, () => false, size), [], 'not short: nothing');
});

test('disk short: the session casting now stays, parked or paused; sizes are read only as needed', () => {
  const casting = s('casting', 30, { owner: 'cast' });
  const castParked = s('cast-parked', 1, { owner: 'cast', parked: true });   // mid-seek: the TV still plays it
  const oldCast = s('old-cast', 3, { owner: 'cast' });
  const keep = (x: HlsSession) => x === casting || x === castParked;
  assert.deepEqual(order(diskVictims([casting, castParked, oldCast], now, 100 * GB, keep, () => GB)), ['old-cast']);
  const sized: string[] = [];
  const empty = s('empty', 1, { parked: true });
  diskVictims([s('big', 2, { parked: true }), empty, s('idle', 3)], now, 1 * GB, () => false, (x) => { sized.push(x.id); return x === empty ? 0 : 5 * GB; });
  assert.deepEqual(sized, ['big'], 'enough after the first');
  assert.deepEqual(order(diskVictims([empty, s('idle', 3)], now, 1 * GB, () => false, () => 0)), ['empty', 'idle'], 'nothing on disk yet: still stopped, it would only grow');
});

test('reaper: when the disk is short it stops parked and idle sessions with "Disk nearly full", spares the rest', async () => {
  const stub = path.join(DIR, 'slow-ffmpeg'); fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const before = process.env.FFMPEG_BIN; process.env.FFMPEG_BIN = stub;
  const sent: string[] = []; let close = () => {};
  addClient({ writeHead() {}, write(x: string) { sent.push(x); return true; }, on(ev: string, fn: () => void) { if (ev === 'close') close = fn; } } as unknown as Response);
  const opts = (owner: string, startOffset = 0) => ({
    infoHash: 'h', fileIdx: 0, sourceUrl: 'http://127.0.0.1:9/none', startOffset, owner,
    decision: { mode: 'hls-transcode', videoCopy: false, audioCopy: false, segment: 'mpegts', audioIndex: 1 } as HlsSession['decision'],
    probe: { container: 'mkv', duration: 100, audio: [], subs: [], video: { codec: 'hevc', height: 1080 } },
  });
  const min = getState().settings.minFreeBytes;
  try {
    const a = hls.start(opts('viewer-1'));
    a.state = 'ready';                               // has media: the next start of the same file parks it
    const watching = hls.start(opts('viewer-1', 600));
    const idle = hls.start(opts('viewer-2'));
    idle.lastAccess = Date.now() - 3 * MIN;         // idle, but not yet the five minutes the plain reaper waits
    assert.equal(a.parked, true);
    getState().settings.minFreeBytes = 0;
    hls.reaper();
    assert.deepEqual(ids(hls.active()), ids([a, watching, idle]), 'room on disk: nothing goes');
    getState().settings.minFreeBytes = Number.MAX_SAFE_INTEGER;   // no disk has that much free
    hls.reaper();
    assert.deepEqual(ids(hls.active()), [watching.id], 'the one being watched stays');
    for (const x of [a, idle]) {
      assert.equal(x.state, 'error');
      assert.match(x.error!, /^Disk nearly full: .* GB free, need .* GB\. Clear the cache in Settings\.$/);
      assert.ok(sent.some((e) => e.startsWith('event: hls.state') && e.includes(`"sessionId":"${x.id}"`) && e.includes('Disk nearly full') && e.includes('"code":"disk-full"')), `event for ${x.id}`);
    }
    await assert.rejects(hls.waitReady(idle, 1000), (e: Error & { code?: string }) => /Disk nearly full/.test(e.message) && e.code === 'disk-full');
    hls.stop(watching.id);
  } finally {
    getState().settings.minFreeBytes = min;
    close();
    if (before === undefined) delete process.env.FFMPEG_BIN; else process.env.FFMPEG_BIN = before;
  }
});
