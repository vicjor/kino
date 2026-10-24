import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HlsSession } from '../server/media/hls.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const hls = await import('../server/media/hls.ts');
const { ffmpegArgs, parseKeyframeRead, seekTarget, seeksEarly, covers, producedSeconds, playlistName } = hls;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

type Video = { codec: string; width?: number; height?: number };
type Opts = { copy?: boolean; audioCopy?: boolean; audioIndex?: number; segment?: 'fmp4' | 'mpegts'; video?: Video; hdr?: boolean; triedNoTonemap?: boolean; triedSwEncode?: boolean };
const session = (o: Opts): HlsSession => ({
  id: 'x', infoHash: 'h', fileIdx: 0, sourceUrl: 'http://x/f', dir: '/hls/x', startOffset: 0, requestedOffset: 0, lastAccess: 0, state: 'starting',
  triedNoTonemap: o.triedNoTonemap, triedSwEncode: o.triedSwEncode,
  decision: { mode: o.copy ? 'hls-copy' : 'hls-transcode', videoCopy: !!o.copy, audioCopy: !!o.audioCopy, segment: o.segment || 'fmp4', audioIndex: o.audioIndex ?? 1 },
  probe: { container: 'mkv', duration: 100, audio: [], subs: [], video: o.video || { codec: 'h264', width: 1920, height: 1080 }, hdr: o.hdr },
});
const args = (o: Opts, hw = false) => ffmpegArgs(session(o), { hw });
/** Value that follows a flag, or undefined when the flag is absent. */
const val = (a: string[], flag: string) => { const i = a.indexOf(flag); return i < 0 ? undefined : a[i + 1]; };
const UHD: Video = { codec: 'hevc', width: 3840, height: 2160 };

test('copy to mpegts converts h264 to annex b, fmp4 does not', () => {
  assert.equal(val(args({ copy: true, segment: 'mpegts' }), '-bsf:v'), 'h264_mp4toannexb');
  assert.equal(val(args({ copy: true, segment: 'fmp4' }), '-bsf:v'), undefined);
  assert.equal(val(args({ copy: true }), '-c:v'), 'copy');
});

test('copied hevc is tagged hvc1, h264 is not', () => {
  assert.equal(val(args({ copy: true, video: { codec: 'hevc' } }), '-tag:v'), 'hvc1');
  assert.equal(val(args({ copy: true }), '-tag:v'), undefined);
});

test('HDR gets the tonemap chain until it has failed once', () => {
  const vf = (o: Opts) => val(args(o), '-vf')!;
  assert.match(vf({ hdr: true }), /^zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,/);
  assert.doesNotMatch(vf({ hdr: true, triedNoTonemap: true }), /tonemap/);
  assert.doesNotMatch(vf({}), /tonemap/);
  assert.match(vf({}), /format=yuv420p$/);
});

test('above 1080 lines scales down to 1080, 1080 and below untouched', () => {
  assert.match(val(args({ video: UHD }), '-vf')!, /scale=-2:1080,format=yuv420p$/);
  assert.equal(val(args({}), '-vf'), 'format=yuv420p');
  assert.equal(val(args({ video: { codec: 'mpeg4' } }), '-vf'), 'format=yuv420p', 'unknown height counts as 1080');
});

test('VideoToolbox: 4500k for HD, 6500k above, no level; libx264 once it has failed', () => {
  const hd = args({}, true);
  assert.equal(val(hd, '-c:v'), 'h264_videotoolbox');
  assert.equal(val(hd, '-b:v'), '4500k'); assert.equal(val(hd, '-maxrate'), '4500k');
  assert.equal(val(hd, '-level'), undefined);
  assert.equal(val(hd, '-crf'), undefined);
  assert.equal(val(args({ video: UHD }, true), '-b:v'), '6500k');
  assert.equal(val(args({ video: { codec: 'h264', width: 2560, height: 1080 } }, true), '-b:v'), '6500k', 'wider than 1920 counts too');
  assert.equal(val(args({ triedSwEncode: true }, true), '-c:v'), 'libx264');
});

test('libx264: high profile, level 4.1 for the old Chromecast, crf 21', () => {
  const a = args({});
  assert.equal(val(a, '-c:v'), 'libx264');
  assert.equal(val(a, '-profile:v'), 'high');
  assert.equal(val(a, '-level'), '4.1');
  assert.equal(val(a, '-crf'), '21');
  assert.equal(val(a, '-sc_threshold'), '0');
});

test('both encoders keep -g and force a keyframe on every 4 s boundary, whatever the frame rate', () => {
  for (const a of [args({}), args({}, true)]) {
    assert.equal(val(a, '-g'), '96');
    assert.equal(val(a, '-force_key_frames'), 'expr:gte(t,n_forced*4)');
  }
  assert.equal(val(args({ copy: true }), '-force_key_frames'), undefined, 'copy cannot place keyframes');
  assert.equal(val(args({ copy: true }), '-g'), undefined);
});

test('audio: copy aac, else stereo aac 192k; no audio stream, no audio args', () => {
  assert.equal(val(args({ audioCopy: true }), '-c:a'), 'copy');
  const enc = args({ audioCopy: false });
  assert.equal(val(enc, '-c:a'), 'aac'); assert.equal(val(enc, '-ac'), '2'); assert.equal(val(enc, '-b:a'), '192k');
  assert.deepEqual(args({ audioIndex: 3 }).filter((x) => x.startsWith('0:')), ['0:v:0', '0:3']);
  const none = args({ audioIndex: -1 });
  assert.equal(val(none, '-c:a'), undefined);
  assert.deepEqual(none.filter((x) => x.startsWith('0:')), ['0:v:0']);
});

test('segment naming: fmp4 writes init.mp4 + .m4s, mpegts writes .ts; playlist is the last argument', () => {
  const f = args({ segment: 'fmp4' });
  assert.equal(val(f, '-hls_segment_type'), 'fmp4');
  assert.equal(val(f, '-hls_fmp4_init_filename'), 'init.mp4');
  assert.equal(val(f, '-hls_segment_filename'), path.join('/hls/x', 'seg%05d.m4s'));
  const t = args({ segment: 'mpegts' });
  assert.equal(val(t, '-hls_segment_type'), 'mpegts');
  assert.equal(val(t, '-hls_fmp4_init_filename'), undefined);
  assert.equal(val(t, '-hls_segment_filename'), path.join('/hls/x', 'seg%05d.ts'));
  for (const a of [f, t]) { assert.equal(a.at(-1), path.join('/hls/x', 'index.m3u8')); assert.equal(val(a, '-hls_time'), '4'); assert.equal(val(a, '-start_number'), '0'); }
});

test('remux with re-encoded audio keeps audio from the keyframe so both streams start together', () => {
  const base = { id: 'x', infoHash: 'h', fileIdx: 0, sourceUrl: 'http://x/f', dir: '/tmp/x', requestedOffset: 600, lastAccess: 0, state: 'starting' as const, probe: { video: { codec: 'h264' } } as unknown as HlsSession['probe'] };
  const dec = (videoCopy: boolean, audioCopy: boolean) => ({ mode: videoCopy ? 'hls-copy' : 'hls-transcode', videoCopy, audioCopy, segment: 'fmp4', audioIndex: 1 }) as unknown as HlsSession['decision'];
  const at = (startOffset: number, d: HlsSession['decision']) => ffmpegArgs({ ...base, startOffset, decision: d }, { hw: false });
  assert.ok(at(600, dec(true, false)).includes('-noaccurate_seek'), 'copy video + aac audio after a seek');
  assert.ok(!at(600, dec(true, true)).includes('-noaccurate_seek'), 'copy both: nothing is trimmed anyway');
  assert.ok(!at(600, dec(false, false)).includes('-noaccurate_seek'), 'transcode: accurate seek trims both streams equally');
  assert.ok(!at(0, dec(true, false)).includes('-noaccurate_seek'), 'no seek, no flag');
  const a = at(600, dec(true, false)); assert.ok(a.indexOf('-noaccurate_seek') < a.indexOf('-i'), 'input option, before -i');
});

// ffprobe's packets after seeking an MPEG-TS (start_time 1.462089, B-frames) as ffmpeg -ss 20 does: non-keyframes
// first, then the keyframe ffmpeg's copy starts on. The keyframe before the offset (stream pts 20.46) is never read.
const TS_START = 1.462089;
const tsRead = (hasB: number) => JSON.stringify({
  packets: [
    { pts_time: '21.294878', dts_time: '21.294878', flags: '___' }, { pts_time: '21.378300', dts_time: '21.336589', flags: '___' },
    { pts_time: '22.796378', dts_time: '22.713000', flags: '___' }, { pts_time: '22.838089', dts_time: '22.754678', flags: 'K__' },
    { pts_time: '22.879800', dts_time: '22.796378', flags: '___' }, { pts_time: '25.215467', dts_time: '25.132044', flags: 'K__' },
  ],
  streams: [{ has_b_frames: hasB }],
});

test('parseKeyframeRead: the first keyframe read (its dts), and whether the video has B-frames', () => {
  assert.deepEqual(parseKeyframeRead(tsRead(2)), { key: 22.754678, bframes: true });
  assert.deepEqual(parseKeyframeRead(tsRead(0)), { key: 22.754678, bframes: false });
  assert.deepEqual(parseKeyframeRead(JSON.stringify({ packets: [{ pts_time: '10.000000', flags: 'K_' }], streams: [{}] })), { key: 10, bframes: false }, 'no dts: pts');
  assert.deepEqual(parseKeyframeRead(JSON.stringify({ packets: [{ pts_time: '10.0', dts_time: 'N/A', flags: 'K_' }] })), { key: 10, bframes: false });
  assert.deepEqual(parseKeyframeRead(JSON.stringify({ packets: [{ pts_time: '10.0', flags: '__' }], streams: [{ has_b_frames: 1 }] })), { bframes: true }, 'no keyframe read');
  assert.deepEqual(parseKeyframeRead('{}'), { bframes: false });
  assert.equal(parseKeyframeRead('not json'), undefined);
});

test('seekTarget: -ss counts from the container start; B-frames seek 3/23 s early, except in MP4', () => {
  assert.equal(seekTarget(20, TS_START, false), 20 + TS_START);
  assert.equal(seekTarget(20, TS_START, true), 20 + TS_START - 3 / 23);
  assert.equal(seekTarget(600, 0, false), 600);
  assert.equal(seeksEarly('ts', true), true);
  assert.equal(seeksEarly('mkv', true), true);
  assert.equal(seeksEarly('mp4', true), false, 'the MP4 demuxer seeks by pts');
  assert.equal(seeksEarly('mkv', false), false);
});

// A stand-in ffprobe: logs its -read_intervals and prints the JSON in $KF_JSON.
const kfLog = path.join(DIR, 'ffprobe-log');
const kfJson = path.join(DIR, 'ffprobe-json');
const fakeProbe = path.join(DIR, 'fake-ffprobe');
fs.writeFileSync(fakeProbe, '#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != "-read_intervals" ]; do shift; done\necho "$2" >> "$KF_LOG"\ncat "$KF_JSON"\n', { mode: 0o755 });
const slowFf = path.join(DIR, 'slow-ffmpeg');
fs.writeFileSync(slowFf, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
/** Starts a copy-mode session at `ss` with the fake ffprobe answering `json`; resolves with the measured start and the seeks it asked for. */
async function measured(ss: number, container: string, startTime: number, json: string, bframes?: boolean): Promise<{ start: number; seeks: string[] }> {
  const before = { probe: process.env.FFPROBE_BIN, ff: process.env.FFMPEG_BIN };
  fs.writeFileSync(kfJson, json); fs.rmSync(kfLog, { force: true });
  Object.assign(process.env, { FFPROBE_BIN: fakeProbe, FFMPEG_BIN: slowFf, KF_LOG: kfLog, KF_JSON: kfJson });
  try {
    const s = hls.start({
      infoHash: 'm', fileIdx: 0, sourceUrl: 'http://127.0.0.1:9/none', startOffset: ss,
      decision: { mode: 'hls-copy', videoCopy: true, audioCopy: true, segment: 'mpegts', audioIndex: 1 } as HlsSession['decision'],
      probe: { container, startTime, duration: 3600, audio: [], subs: [], video: { codec: 'h264' }, bframes },
    });
    await s.measured;
    hls.stop(s.id);
    return { start: s.startOffset, seeks: fs.readFileSync(kfLog, 'utf8').trim().split('\n') };
  } finally {
    for (const [k, v] of [['FFPROBE_BIN', before.probe], ['FFMPEG_BIN', before.ff]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('copy start on an MPEG-TS starting at 1.46 s: seeks where ffmpeg did, starts on the keyframe after the offset', async () => {
  const r = await measured(20, 'ts', TS_START, tsRead(2));
  assert.deepEqual(r.seeks, [`${(20 + TS_START - 3 / 23).toFixed(6)}%+10`], 'stream time, 3/23 s early for B-frames, one read');
  assert.equal(r.start, 21.293, 'keyframe dts 22.754678 minus the 1.462089 start, not the keyframe before 20');
});

test('copy start: a wrong B-frame guess reads again from where ffmpeg really seeks; MP4 never seeks early', async () => {
  const noB = await measured(20, 'ts', TS_START, tsRead(0));
  assert.deepEqual(noB.seeks, [`${(20 + TS_START - 3 / 23).toFixed(6)}%+10`, `${(20 + TS_START).toFixed(6)}%+10`]);
  assert.equal(noB.start, 21.293);
  const mp4 = await measured(20, 'mp4', 0, tsRead(2));
  assert.deepEqual(mp4.seeks, ['20.000000%+10']);
});

test('copy start: the probe\'s has_b_frames picks the seek, so a stream without B-frames reads once', async () => {
  const noB = await measured(20, 'ts', TS_START, tsRead(0), false);
  assert.deepEqual(noB.seeks, [`${(20 + TS_START).toFixed(6)}%+10`], 'not early, no second read');
  assert.equal(noB.start, 21.293);
  const b = await measured(20, 'mkv', 0, tsRead(2), true);
  assert.deepEqual(b.seeks, [`${(20 - 3 / 23).toFixed(6)}%+10`]);
  const stale = await measured(20, 'ts', TS_START, tsRead(0), true);
  assert.deepEqual(stale.seeks, [`${(20 + TS_START - 3 / 23).toFixed(6)}%+10`, `${(20 + TS_START).toFixed(6)}%+10`], 'this read disagrees with the probe: it wins, as ffmpeg saw it');
});

test('copy start: no keyframe in 10 s reads 40; nothing at all keeps the requested offset', async () => {
  const none = await measured(20, 'mkv', 0, JSON.stringify({ packets: [], streams: [{ has_b_frames: 2 }] }));
  assert.deepEqual(none.seeks, [`${(20 - 3 / 23).toFixed(6)}%+10`, `${(20 - 3 / 23).toFixed(6)}%+40`]);
  assert.equal(none.start, 20);
  assert.equal((await measured(20, 'mkv', 0, 'garbage')).start, 20, 'ffprobe output it cannot read');
});

/** A session whose playlist on disk lists segments of these durations, starting at startOffset. */
const withSegments = (startOffset: number, segs: number[], state: HlsSession['state'] = 'ready'): HlsSession => {
  const dir = fs.mkdtempSync(path.join(DIR, 'hls-'));
  fs.writeFileSync(path.join(dir, playlistName()), ['#EXTM3U', ...segs.map((d, i) => `#EXTINF:${d},\nseg${i}.ts`)].join('\n'));
  return { id: 'x', infoHash: 'h', fileIdx: 0, sourceUrl: '', dir, startOffset, requestedOffset: startOffset, decision: {} as HlsSession['decision'], probe: {} as HlsSession['probe'], lastAccess: 0, state };
};

test('producedSeconds sums segment durations', () => {
  assert.equal(producedSeconds(withSegments(0, [4, 4, 3.5])), 11.5);
});

test('covers: inside the produced range, minus a second of slack at the edge', () => {
  const s = withSegments(600, [4, 4, 4, 4, 4]);   // 600 .. 620
  assert.equal(covers(s, 600), true);
  assert.equal(covers(s, 612), true);
  assert.equal(covers(s, 619), true);
  assert.equal(covers(s, 619.5), false);
  assert.equal(covers(s, 599), false);
  assert.equal(covers(withSegments(600, [4, 4], 'starting'), 601), false);
  assert.equal(covers(withSegments(600, [4, 4], 'ended'), 601), true, 'a finished session keeps its range');
  assert.equal(covers(withSegments(600, [4, 4], 'error'), 601), false);
});

// Stands in for an ffmpeg that writes three 4 s segments into the playlist (its last argument) and exits 0.
const quick = path.join(DIR, 'quick-ffmpeg');
fs.writeFileSync(quick, '#!/bin/sh\nfor a; do last=$a; done\nprintf \'#EXTM3U\\n#EXTINF:4,\\nseg0.ts\\n#EXTINF:4,\\nseg1.ts\\n#EXTINF:4,\\nseg2.ts\\n#EXT-X-ENDLIST\\n\' > "$last"\n', { mode: 0o755 });
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(ok()); };
const startOpts = (startOffset: number, infoHash = 'h') => ({
  infoHash, fileIdx: 0, sourceUrl: 'http://127.0.0.1:9/none', startOffset, owner: 'tester',
  decision: { mode: 'hls-transcode', videoCopy: false, audioCopy: false, segment: 'mpegts', audioIndex: 1 } as HlsSession['decision'],
  probe: { container: 'mkv', duration: 3600, audio: [], subs: [], video: { codec: 'hevc', height: 1080 } },
});

test('a finished session is parked like a running one, and a seek back into it reuses it', async () => {
  process.env.FFMPEG_BIN = quick;
  const a = hls.start(startOpts(0));
  await until(() => a.state === 'ended');
  const b = hls.start(startOpts(600));
  assert.equal(hls.get(a.id), a, 'kept, not deleted');
  assert.equal(a.parked, true);
  await until(() => b.state === 'ended');
  const back = hls.seek(b, 5);
  assert.equal(back, a, 'the rewind switches to the finished session, no new ffmpeg');
  assert.equal(a.parked, false);
  assert.equal(b.parked, true);
  assert.equal(hls.seek(a, 9), a, 'inside its own range: the same session');
  const other = hls.start(startOpts(0, 'other-file'));
  assert.equal(hls.get(a.id), undefined, 'another file: the finished ones go');
  assert.equal(hls.get(b.id), undefined);
  hls.stop(other.id);
});
