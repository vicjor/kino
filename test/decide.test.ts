import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, pickAudio } from '../server/media/decide.ts';
import type { ProbeInfo } from '../server/types.ts';

const p = (o: Partial<ProbeInfo>): ProbeInfo => ({ container: 'mkv', duration: 100, video: { codec: 'h264' }, audio: [{ index: 1, codec: 'aac', lang: 'eng' }], subs: [], ...o });

test('chrome plays mkv h264/aac directly', () => {
  assert.equal(decide(p({}), 'browser').mode, 'direct');
});
test('ios needs hls for mkv, copies h264 video', () => {
  const d = decide(p({}), 'ios');
  assert.equal(d.mode, 'hls-copy'); assert.equal(d.segment, 'fmp4'); assert.equal(d.audioCopy, true);
});
test('ios plays mp4 hevc aac directly', () => {
  assert.equal(decide(p({ container: 'mp4', video: { codec: 'hevc' } }), 'ios').mode, 'direct');
});
test('chromecast: mp4 h264 aac direct, hevc transcodes with mpegts, ac3 -> aac', () => {
  assert.equal(decide(p({ container: 'mp4' }), 'chromecast').mode, 'direct');
  const d = decide(p({ video: { codec: 'hevc' }, audio: [{ index: 1, codec: 'ac3' }] }), 'chromecast');
  assert.equal(d.mode, 'hls-transcode'); assert.equal(d.segment, 'mpegts'); assert.equal(d.audioCopy, false); assert.equal(d.videoCopy, false);
});
test('browser hevc: copy only when client says it can', () => {
  assert.equal(decide(p({ video: { codec: 'hevc' } }), 'browser').mode, 'hls-transcode');
  assert.equal(decide(p({ video: { codec: 'hevc' } }), 'browser', { caps: { hevc: true } }).mode, 'direct');
  assert.equal(decide(p({ video: { codec: 'hevc' }, audio: [{ index: 1, codec: 'dts' }] }), 'browser', { caps: { hevc: true } }).mode, 'hls-copy');
});
test('browser av1: transcodes without the cap, plays or copies with it', () => {
  const av1 = p({ video: { codec: 'av1' } });
  const no = decide(av1, 'browser');
  assert.equal(no.mode, 'hls-transcode'); assert.equal(no.reason, 'av1 video not supported on browser'); assert.equal(no.videoCopy, false);
  assert.equal(decide(av1, 'browser', { caps: { av1: false } }).mode, 'hls-transcode');
  const cap = { caps: { av1: true } };
  assert.equal(decide(av1, 'browser', cap).mode, 'direct', 'Matroska through the WebM demuxer');
  assert.equal(decide(p({ container: 'mp4', video: { codec: 'av1' } }), 'browser', cap).mode, 'direct');
  assert.equal(decide(p({ container: 'webm', video: { codec: 'av1' }, audio: [{ index: 1, codec: 'opus' }] }), 'browser', { caps: { av1: true, mkv: false } }).mode, 'direct');
  // Firefox: AV1 but no Matroska, so the video is copied into fMP4 for hls.js.
  const ff = decide(av1, 'browser', { caps: { av1: true, mkv: false } });
  assert.deepEqual(ff, { mode: 'hls-copy', reason: 'mkv container not supported on browser', videoCopy: true, audioCopy: true, segment: 'fmp4', audioIndex: 1 });
  const dts = decide(p({ video: { codec: 'av1' }, audio: [{ index: 1, codec: 'dts' }] }), 'browser', cap);
  assert.equal(dts.mode, 'hls-copy'); assert.equal(dts.videoCopy, true); assert.equal(dts.audioCopy, false);
  assert.equal(decide(p({ container: 'avi', video: { codec: 'av1' } }), 'browser', cap).mode, 'hls-copy');
  const hdr = decide(av1, 'browser', { ...cap, hdr: true });
  assert.equal(hdr.mode, 'hls-transcode'); assert.equal(hdr.videoCopy, false);
});
test('av1 and hevc caps are independent', () => {
  assert.equal(decide(p({ video: { codec: 'hevc' } }), 'browser', { caps: { av1: true } }).mode, 'hls-transcode');
  assert.equal(decide(p({ video: { codec: 'av1' } }), 'browser', { caps: { hevc: true } }).mode, 'hls-transcode');
  assert.equal(decide(p({ video: { codec: 'av1' } }), 'browser', { caps: { hevc: true, av1: true } }).mode, 'direct');
});
test('caps.av1 leaves iOS and the Chromecast transcoding av1', () => {
  const caps = { av1: true, hevc: true, mkv: true };
  for (const container of ['mp4', 'mkv']) {
    const f = p({ container, video: { codec: 'av1' } });
    const ios = decide(f, 'ios', { caps });
    assert.equal(ios.mode, 'hls-transcode', `ios ${container}`); assert.equal(ios.segment, 'fmp4');
    assert.deepEqual(ios, decide(f, 'ios'), `ios ${container}: same as without caps`);
    const cc = decide(f, 'chromecast', { caps });
    assert.equal(cc.mode, 'hls-transcode', `chromecast ${container}`); assert.equal(cc.segment, 'mpegts');
    assert.deepEqual(cc, decide(f, 'chromecast'), `chromecast ${container}: same as without caps`);
  }
});
test('hdr forces transcode', () => {
  assert.equal(decide(p({ container: 'mp4' }), 'browser', { hdr: true }).mode, 'hls-transcode');
});
test('second audio track forces hls', () => {
  const pr = p({ audio: [{ index: 1, codec: 'aac', lang: 'jpn' }, { index: 2, codec: 'aac', lang: 'eng' }] });
  assert.equal(pickAudio(pr, undefined, ['eng']), 2);
  assert.equal(decide(pr, 'browser', { audioIndex: 2 }).mode, 'hls-copy');
  assert.equal(decide(pr, 'browser', { audioIndex: 1 }).mode, 'direct');
});
test('reason names the first rule that failed', () => {
  const second = p({ audio: [{ index: 1, codec: 'aac', lang: 'jpn' }, { index: 2, codec: 'aac', lang: 'eng' }] });
  assert.equal(decide(second, 'browser', { audioIndex: 2 }).reason, 'only the first audio track plays directly');
  assert.equal(decide(p({ container: 'avi', audio: [{ index: 1, codec: 'mp3' }] }), 'browser').reason, 'avi container not supported on browser');
  assert.equal(decide(p({}), 'browser', { caps: { mkv: false } }).reason, 'mkv container not supported on browser');
  assert.equal(decide(p({ container: 'mp4', video: { codec: 'vp9' }, audio: [{ index: 1, codec: 'ac3' }] }), 'ios').reason, 'vp9 video not supported on ios');
  assert.equal(decide(p({ container: 'mp4', audio: [{ index: 1, codec: 'ac3' }] }), 'chromecast').reason, 'ac3 audio not supported on chromecast');
  assert.equal(decide(p({}), 'browser', { hdr: true }).reason, 'HDR needs tone-mapping');
  assert.equal(decide(p({}), 'browser', { hdr: true, forceHls: true }).reason, 'requested');
  assert.equal(decide(p({}), 'browser').reason, undefined);
});

// The most common Chromecast case: an MKV with H.264 and AAC only needs a remux into MPEG-TS.
test('chromecast: mkv h264 aac remuxes (hls-copy, mpegts, both streams copied)', () => {
  assert.deepEqual(decide(p({}), 'chromecast'), { mode: 'hls-copy', reason: 'mkv container not supported on chromecast', videoCopy: true, audioCopy: true, segment: 'mpegts', audioIndex: 1 });
  const ac3 = decide(p({ audio: [{ index: 1, codec: 'ac3', lang: 'eng' }] }), 'chromecast');
  assert.equal(ac3.mode, 'hls-copy'); assert.equal(ac3.segment, 'mpegts'); assert.equal(ac3.videoCopy, true); assert.equal(ac3.audioCopy, false);
  const mp3 = decide(p({ container: 'mp4', audio: [{ index: 1, codec: 'mp3' }] }), 'chromecast');
  assert.equal(mp3.mode, 'direct'); assert.equal(mp3.segment, 'fmp4');
});
test('chromecast: hdr h264 transcodes even though the codec would copy', () => {
  const d = decide(p({ container: 'mp4' }), 'chromecast', { hdr: true });
  assert.equal(d.mode, 'hls-transcode'); assert.equal(d.videoCopy, false); assert.equal(d.audioCopy, true); assert.equal(d.segment, 'mpegts');
});
test('browser without mkv support remuxes into fmp4, other containers unaffected', () => {
  const d = decide(p({}), 'browser', { caps: { mkv: false } });
  assert.equal(d.mode, 'hls-copy'); assert.equal(d.segment, 'fmp4'); assert.equal(d.videoCopy, true); assert.equal(d.audioCopy, true);
  assert.equal(decide(p({ container: 'mp4' }), 'browser', { caps: { mkv: false } }).mode, 'direct');
  assert.equal(decide(p({ container: 'webm', video: { codec: 'vp9' }, audio: [{ index: 1, codec: 'opus' }] }), 'browser', { caps: { mkv: false } }).mode, 'direct');
  assert.equal(decide(p({}), 'browser', { caps: { mkv: true } }).mode, 'direct');
});
test('forceHls turns a direct file into hls-copy on every target', () => {
  const b = decide(p({ container: 'mp4' }), 'browser', { forceHls: true });
  assert.equal(b.mode, 'hls-copy'); assert.equal(b.reason, 'requested'); assert.equal(b.segment, 'fmp4');
  const cc = decide(p({ container: 'mp4' }), 'chromecast', { forceHls: true });
  assert.equal(cc.mode, 'hls-copy'); assert.equal(cc.segment, 'mpegts');
  const hevc = decide(p({ container: 'mp4', video: { codec: 'hevc' } }), 'ios', { forceHls: true });
  assert.equal(hevc.mode, 'hls-copy'); assert.equal(hevc.videoCopy, true);
});
test('ios copies hevc out of mkv, transcodes av1, re-encodes dts', () => {
  const d = decide(p({ video: { codec: 'hevc' } }), 'ios');
  assert.equal(d.mode, 'hls-copy'); assert.equal(d.reason, 'mkv container not supported on ios'); assert.equal(d.segment, 'fmp4');
  assert.equal(decide(p({ video: { codec: 'av1' } }), 'ios').mode, 'hls-transcode');
  const dts = decide(p({ container: 'mp4', audio: [{ index: 1, codec: 'dts' }] }), 'ios');
  assert.equal(dts.reason, 'dts audio not supported on ios'); assert.equal(dts.mode, 'hls-copy'); assert.equal(dts.audioCopy, false);
});
test('missing streams: no audio or no video never plays directly', () => {
  const silent = decide(p({ container: 'mp4', audio: [] }), 'browser');
  assert.equal(silent.reason, 'none audio not supported on browser'); assert.equal(silent.audioIndex, -1); assert.equal(silent.audioCopy, false); assert.equal(silent.mode, 'hls-copy');
  const noVideo = decide(p({ container: 'mp4', video: undefined }), 'browser');
  assert.equal(noVideo.reason, 'none video not supported on browser'); assert.equal(noVideo.mode, 'hls-transcode'); assert.equal(noVideo.videoCopy, false);
});
test('unknown audioIndex falls back to the first track', () => {
  const pr = p({ audio: [{ index: 3, codec: 'aac', lang: 'eng' }, { index: 4, codec: 'ac3', lang: 'eng' }] });
  const d = decide(pr, 'browser', { audioIndex: 99 });
  assert.equal(d.audioIndex, 3); assert.equal(d.mode, 'direct');
  const second = decide(pr, 'browser', { audioIndex: 4 });
  assert.equal(second.audioIndex, 4); assert.equal(second.reason, 'ac3 audio not supported on browser'); assert.equal(second.audioCopy, false);
});

test('pickAudio: an explicit choice wins only when that stream exists', () => {
  const pr = p({ audio: [{ index: 1, codec: 'aac', lang: 'eng' }, { index: 2, codec: 'aac', lang: 'fra' }] });
  assert.equal(pickAudio(pr, 2), 2);
  assert.equal(pickAudio(pr, 7), 1);
  assert.equal(pickAudio(pr), 1);
});
test('pickAudio: English by tag alias or by title, before other preferred languages', () => {
  const tagged = p({ audio: [{ index: 1, codec: 'aac', lang: 'ger' }, { index: 2, codec: 'aac', lang: 'en' }] });
  assert.equal(pickAudio(tagged, undefined, ['deu']), 2);
  const spelled = p({ audio: [{ index: 1, codec: 'aac', lang: 'ger' }, { index: 2, codec: 'aac', lang: 'English' }] });
  assert.equal(pickAudio(spelled, undefined, ['deu']), 2);
  const byTitle = p({ audio: [{ index: 1, codec: 'aac', title: 'Japanese' }, { index: 2, codec: 'aac', title: 'English 5.1' }] });
  assert.equal(pickAudio(byTitle), 2);
  const shortTitle = p({ audio: [{ index: 1, codec: 'aac', lang: 'und', title: 'JPN' }, { index: 2, codec: 'aac', lang: 'und', title: 'ENG stereo' }] });
  assert.equal(pickAudio(shortTitle), 2);
  // "Bengali" has "eng" inside a word: not English.
  const bengali = p({ audio: [{ index: 1, codec: 'aac', title: 'Hindi' }, { index: 2, codec: 'aac', title: 'Bengali' }] });
  assert.equal(pickAudio(bengali), 1);
});
test('pickAudio: second preferred language by alias when there is no English', () => {
  const pr = p({ audio: [{ index: 1, codec: 'aac', lang: 'jpn' }, { index: 2, codec: 'aac', lang: 'ger' }, { index: 3, codec: 'aac', lang: 'fre' }] });
  assert.equal(pickAudio(pr, undefined, ['fre']), 3);
  assert.equal(pickAudio(pr, undefined, ['ger']), 2);
  assert.equal(pickAudio(pr, undefined, ['ita']), 1);
});
test('pickAudio: skips commentary and descriptive tracks when no language matches', () => {
  const pr = p({ audio: [{ index: 1, codec: 'aac', title: "Director's Commentary" }, { index: 2, codec: 'aac', title: 'Audio Description' }, { index: 3, codec: 'aac', title: 'Main' }] });
  assert.equal(pickAudio(pr), 3);
  const untitled = p({ audio: [{ index: 1, codec: 'aac', title: 'Descriptive audio' }, { index: 2, codec: 'aac' }] });
  assert.equal(pickAudio(untitled), 2);
  const allCommentary = p({ audio: [{ index: 5, codec: 'aac', title: 'Commentary 1' }, { index: 6, codec: 'aac', title: 'Commentary 2' }] });
  assert.equal(pickAudio(allCommentary), 5);
  assert.equal(pickAudio(p({ audio: [] })), -1);
});
test('webm: direct where the browser plays WebM but not Matroska, iOS and the Chromecast unchanged', () => {
  const webm = p({ container: 'webm', video: { codec: 'vp9' }, audio: [{ index: 1, codec: 'opus' }] });
  const asMkv = { ...webm, container: 'mkv' };
  const noMkv = { caps: { mkv: false } };
  assert.equal(decide(asMkv, 'browser', noMkv).mode, 'hls-transcode', 'what WebM got when it was taken for Matroska');
  assert.equal(decide(webm, 'browser', noMkv).mode, 'direct');
  assert.equal(decide(webm, 'browser', { caps: { mkv: true } }).mode, 'direct');
  assert.equal(decide(p({ container: 'webm', video: { codec: 'vp8' }, audio: [{ index: 1, codec: 'vorbis' }] }), 'browser', noMkv).mode, 'direct');
  assert.equal(decide(p({ container: 'webm', video: { codec: 'av1' }, audio: [{ index: 1, codec: 'opus' }] }), 'browser', noMkv).reason, 'av1 video not supported on browser');
  for (const tg of ['ios', 'chromecast'] as const) {
    const { reason, ...d } = decide(webm, tg);
    const { reason: was, ...before } = decide(asMkv, tg);
    assert.deepEqual(d, before, `${tg}: same decision as before`);
    assert.equal(d.mode, 'hls-transcode');
    assert.equal(reason, `webm container not supported on ${tg}`);
    assert.equal(was, `mkv container not supported on ${tg}`);
  }
});
