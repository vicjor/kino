import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FfprobeOut } from '../server/media/probe.ts';
import { wrongCpuBinary, notMac } from './wrong-cpu.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
process.env.LOG_LEVEL = 'warn';   // before config.ts loads: it reads the environment once
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const { toProbeInfo, probe, probeCached, probeFailure } = await import('../server/media/probe.ts');
const { BinError } = await import('../server/media/bins.ts');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

/** Drops undefined fields, as the JSON API does. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const MKV_HDR: FfprobeOut = {
  format: { format_name: 'matroska,webm', duration: '3600.123000', start_time: '0.000000' },
  streams: [
    // Cover art first on purpose: it must not be taken for the video.
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900, has_b_frames: 0, disposition: { default: 0, attached_pic: 1 }, tags: { filename: 'cover.jpg', mimetype: 'image/jpeg' } },
    { index: 1, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160, has_b_frames: 2, color_transfer: 'smpte2084', disposition: { default: 1, attached_pic: 0 } },
    { index: 2, codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng', title: 'English 5.1' } },
    { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'jpn' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'SDH' } },
    { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'nor' } },
  ],
  chapters: [
    { start_time: '0.000000', end_time: '92.500000', tags: { title: 'Opening' } },
    { start_time: '92.500000', end_time: '3480.000000' },
    { start_time: 'N/A', end_time: 'N/A', tags: { title: 'broken' } },
  ],
};
const MP4: FfprobeOut = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1325.500000', start_time: '0.000000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 41, width: 1920, height: 1080, has_b_frames: 0, color_transfer: 'bt709', disposition: { attached_pic: 0 }, tags: { language: 'und' } },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng', handler_name: 'SoundHandler' } },
  ],
};
const TS: FfprobeOut = {
  format: { format_name: 'mpegts', duration: '1800.000000', start_time: '1.400000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'Main', level: 40, width: 1280, height: 720 },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'nor' } },
    { index: 2, codec_type: 'audio', codec_name: 'mp2', channels: 2 },
    { index: 3, codec_type: 'data', codec_name: 'scte_35' },
  ],
};

test('toProbeInfo: MKV HEVC HDR10, cover art skipped, two audio tracks, subtitles, chapters', () => {
  assert.deepEqual(plain(toProbeInfo(MKV_HDR)), {
    container: 'mkv', duration: 3600.123, startTime: 0,
    video: { codec: 'hevc', profile: 'Main 10', level: 153, width: 3840, height: 2160 },
    audio: [{ index: 2, codec: 'eac3', channels: 6, lang: 'eng', title: 'English 5.1' }, { index: 3, codec: 'aac', channels: 2, lang: 'jpn' }],
    subs: [{ index: 4, codec: 'subrip', lang: 'eng', title: 'SDH' }, { index: 5, codec: 'hdmv_pgs_subtitle', lang: 'nor' }],
    hdr: true, bframes: true,
    chapters: [{ start: 0, end: 92.5, title: 'Opening' }, { start: 92.5, end: 3480 }],
  });
});

test('toProbeInfo: MP4 H.264 AAC, SDR, no chapters', () => {
  assert.deepEqual(plain(toProbeInfo(MP4)), {
    container: 'mp4', duration: 1325.5, startTime: 0,
    video: { codec: 'h264', profile: 'High', level: 41, width: 1920, height: 1080 },
    audio: [{ index: 1, codec: 'aac', channels: 2, lang: 'eng' }],
    subs: [], hdr: false, bframes: false, chapters: [],
  });
});

test('toProbeInfo: MPEG-TS keeps its start time, data streams ignored', () => {
  const info = toProbeInfo(TS);
  assert.equal(info.container, 'ts');
  assert.equal(info.startTime, 1.4);
  assert.deepEqual(info.audio.map((a) => [a.index, a.codec, a.lang]), [[1, 'ac3', 'nor'], [2, 'mp2', undefined]]);
  assert.deepEqual(info.subs, []);
  assert.equal(info.hdr, false);
  assert.equal(info.bframes, undefined, 'no has_b_frames: unknown, not false');
});

test('toProbeInfo: HLG is HDR, cover art alone is no video, nothing at all is unknown', () => {
  assert.equal(toProbeInfo({ streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', color_transfer: 'arib-std-b67' }] }).hdr, true);
  const art = toProbeInfo({ format: { format_name: 'mp3' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'png', disposition: { attached_pic: 1 } }] });
  assert.equal(art.video, undefined); assert.equal(art.hdr, false); assert.equal(art.container, 'mp3');
  assert.deepEqual(plain(toProbeInfo({})), { container: 'unknown', duration: 0, startTime: 0, audio: [], subs: [], hdr: false, chapters: [] });
});

/** What ffprobe says for Matroska and WebM alike, with these codecs. */
const mkvOf = (video: string, audio: string, art = false): FfprobeOut => ({
  format: { format_name: 'matroska,webm', duration: '60.000000' },
  streams: [
    ...(art ? [{ index: 2, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] : []),
    { index: 0, codec_type: 'video', codec_name: video }, { index: 1, codec_type: 'audio', codec_name: audio },
    { index: 3, codec_type: 'subtitle', codec_name: 'webvtt' },
  ],
});

test('toProbeInfo: WebM when the codecs are WebM ones and the name, if known, ends in .webm', () => {
  const c = (d: FfprobeOut, name?: string) => toProbeInfo(d, name).container;
  assert.equal(c(mkvOf('vp9', 'opus')), 'webm', 'no name: the codecs decide');
  assert.equal(c(mkvOf('vp9', 'opus'), 'Clip.webm'), 'webm');
  assert.equal(c(mkvOf('vp8', 'vorbis'), 'CLIP.WEBM'), 'webm');
  assert.equal(c(mkvOf('av1', 'opus', true), 'Clip.webm'), 'webm', 'cover art is not a stream that counts');
  assert.equal(c(mkvOf('vp9', 'opus'), 'Clip.mkv'), 'mkv', 'a .mkv is served as Matroska, whatever it holds');
  assert.equal(c(mkvOf('vp9', 'opus'), 'Clip'), 'mkv');
  assert.equal(c(mkvOf('h264', 'aac'), 'Clip.webm'), 'mkv', 'H.264 and AAC are not WebM, whatever the name');
  assert.equal(c(mkvOf('vp9', 'aac')), 'mkv');
  assert.equal(c({ format: { format_name: 'matroska,webm' }, streams: [{ index: 0, codec_type: 'subtitle', codec_name: 'webvtt' }] }), 'mkv', 'no audio or video at all');
});

test('probe: the loaded torrent file name tells WebM from Matroska', async () => {
  const { EventEmitter } = await import('node:events');
  const torrent = await import('../server/torrent.ts');
  const store = await import('../server/store.ts');
  store.update((s) => { s.settings.minFreeBytes = 0; });
  const h = 'e'.repeat(40);
  const ft = Object.assign(new EventEmitter(), { infoHash: h, name: 'Clips', destroyed: false, files: [] as { name: string; deselect: () => void }[], destroy(_o?: unknown, cb?: () => void) { this.destroyed = true; cb?.(); } });
  torrent.setClientForTests({ add: () => ft } as never);   // a fake: never joins a swarm
  try {
    const loaded = torrent.ensure(h);
    ft.files = ['Clip.mkv', 'Clip.webm'].map((name) => ({ name, deselect: () => {} }));
    ft.emit('metadata');
    await loaded;
    const run = async () => mkvOf('vp9', 'opus');
    assert.equal((await probe(`${h}:0`, 'u', 1000, run)).container, 'mkv');
    assert.equal((await probe(`${h}:1`, 'u', 1000, run)).container, 'webm');
  } finally { await torrent.remove(h); torrent.setClientForTests(null); store.flushSync(); }
});

test('probe: concurrent asks for one file run ffprobe once', async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const run = async () => { calls++; await gate; return MP4; };
  const a = probe('same', 'u', 1000, run); const b = probe('same', 'u', 1000, run);
  assert.equal(probeCached('same'), undefined, 'nothing cached until it is done');
  release();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(x, y);
  assert.equal(probeCached('same'), x);
  await probe('same', 'u', 1000, run);
  assert.equal(calls, 1, 'later asks hit the cache');
});

test('probe: a failure is shared by the callers waiting on it, then forgotten', async () => {
  let calls = 0;
  const bad = async (): Promise<FfprobeOut> => { calls++; throw new Error('ffprobe failed: boom'); };
  await Promise.all([assert.rejects(probe('bad', 'u', 1000, bad), /boom/), assert.rejects(probe('bad', 'u', 1000, bad), /boom/)]);
  assert.equal(calls, 1);
  assert.equal(probeCached('bad'), undefined);
  assert.equal((await probe('bad', 'u', 1000, async () => MP4)).container, 'mp4', 'the next ask runs again');
});

test('probe: keeps the 200 most recently asked files', async () => {
  const run = async () => TS;
  for (let i = 0; i < 200; i++) await probe(`f${i}`, 'u', 1000, run);
  await probe('f0', 'u', 1000, run);            // asked again: now the newest
  await probe('f200', 'u', 1000, run);          // one more pushes out the oldest ones
  assert.ok(probeCached('f0'));
  assert.equal(probeCached('f1'), undefined);
  assert.ok(probeCached('f2'));
  assert.ok(probeCached('f200'));
});

test('probe: an ffprobe that cannot start is a BinError, not a stream problem', async () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'probe-'));
  const plain = path.join(tmp, 'ffprobe'); fs.writeFileSync(plain, 'not a program', { mode: 0o644 });
  const before = process.env.FFPROBE_BIN;
  try {
    process.env.FFPROBE_BIN = path.join(tmp, 'missing');   // read per probe
    await assert.rejects(probe('nobin', 'http://127.0.0.1:9/x', 1000), (e: unknown) => e instanceof BinError && e.why === 'not found' && /^Kino could not run ffprobe on this \w+ \(not found\)/.test(e.message));
    process.env.FFPROBE_BIN = plain;
    await assert.rejects(probe('noexec', 'http://127.0.0.1:9/x', 1000), (e: unknown) => e instanceof BinError && e.why === 'not executable');
  } finally { if (before === undefined) delete process.env.FFPROBE_BIN; else process.env.FFPROBE_BIN = before; }
});

test('probe: an ffprobe for another CPU (no Rosetta) says so, not "slow torrent"', { skip: notMac }, async () => {
  const before = process.env.FFPROBE_BIN;
  try {
    process.env.FFPROBE_BIN = wrongCpuBinary(fs.mkdtempSync(path.join(DIR, 'probe-')), 'ffprobe');
    const e = await probe('badcpu', 'http://127.0.0.1:9/x', 1000).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof BinError);
    assert.equal(e.why, 'bad CPU type');
    assert.equal(probeFailure(e).message, 'Kino could not run ffprobe on this Mac (bad CPU type). See the server log.');
    assert.equal(probeCached('badcpu'), undefined, 'not cached: a fixed binary works on the next try');
  } finally { if (before === undefined) delete process.env.FFPROBE_BIN; else process.env.FFPROBE_BIN = before; }
});

test('probeFailure: slow torrent advice only when the stream is the problem', () => {
  const local = probeFailure(new BinError('ffprobe', '/x/ffprobe', 'bad CPU type'));
  assert.equal(local.status, 500);
  assert.equal(local.code, 'tool-broken', 'the player words it as this machine\'s problem');
  assert.match(local.message, /^Kino could not run ffprobe on this \w+ \(bad CPU type\)\. See the server log\.$/);
  assert.doesNotMatch(local.message, /torrent|Could not read the stream/);
  const slow = probeFailure(new Error('ffprobe failed: Command failed: ffprobe -v error http://127.0.0.1:1234/api/file/abc/0'));
  assert.equal(slow.status, 504);
  assert.equal(slow.code, 'unreadable');
  assert.match(slow.message, /^Could not read the stream \(ffprobe failed: .*\)\. Slow or dead torrent, try another source\.$/);
});
