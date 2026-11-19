import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlayResponse, SubtitleTrack } from '../server/types.ts';
import { switchWords, noEpisodeSourceWords, playHow, speedStep, speedWords, clampSeek, bigJumpBack, withMark, rangePairs, inRanges, nextPopupAt, upNextMode, doubleTapSkip, bestInLang, subToTurnOn, stallWaitMs } from '../client/lib/playback.ts';

test('switchWords: provider or addon, then the resolution unless it is "other"', () => {
  assert.equal(switchWords({ provider: 'Alpha', addon: 'Addon', resolution: '1080p' }), 'Switching to Alpha 1080p');
  assert.equal(switchWords({ addon: 'Addon', resolution: 'other' }), 'Switching to Addon');
  assert.equal(switchWords({ addon: 'Addon' }), 'Switching to Addon');
});

test('noEpisodeSourceWords: none at all, or none good; the next one or that one', () => {
  assert.equal(noEpisodeSourceWords(true), 'No good source found for that episode');
  assert.equal(noEpisodeSourceWords(false), 'No sources for that episode');
  assert.equal(noEpisodeSourceWords(true, true), 'No good source found for the next episode');
  assert.equal(noEpisodeSourceWords(false, true), 'No sources for the next episode');
});

test('playHow: the mode in plain words, then codec and height when known', () => {
  const base = { url: '', infoHash: 'a', fileIdx: 0, fileName: 'x', sizeBytes: 1 };
  assert.equal(playHow(null), undefined);
  assert.equal(playHow({ ...base, mode: 'direct' } as PlayResponse), 'Direct');
  assert.equal(playHow({ ...base, mode: 'hls-copy', probe: { video: { codec: 'hevc', height: 2160 } } } as unknown as PlayResponse), 'Remuxed · HEVC 2160p');
  assert.equal(playHow({ ...base, mode: 'hls-transcode', probe: { video: { codec: 'h264' } } } as unknown as PlayResponse), 'Transcoded · H264');
});

test('speedStep: one step up or down the ladder, held at both ends', () => {
  assert.equal(speedStep(1, 1), 1.25);
  assert.equal(speedStep(1, -1), 0.75);
  assert.equal(speedStep(2, 1), 2);
  assert.equal(speedStep(0.5, -1), 0.5);
  assert.equal(speedStep(1.1, 1), 1.5, 'off the ladder: from the next step up');
  assert.equal(speedWords(1), 'Normal speed');
  assert.equal(speedWords(1.5), '1.5×');
});

test('clampSeek and bigJumpBack', () => {
  assert.equal(clampSeek(-5, 100), 0);
  assert.equal(clampSeek(200, 100), 99);
  assert.equal(clampSeek(200, 0), 200, 'no duration yet: anything forward goes');
  assert.equal(bigJumpBack(600, 100), true);
  assert.equal(bigJumpBack(80, 0), false, 'early on there is nothing to come back to');
  assert.equal(bigJumpBack(600, 560), false, 'a small step back is not a jump');
});

test('withMark: one mark per half minute, newest three kept', () => {
  assert.deepEqual(withMark([{ t: 100, label: 'a' }], { t: 110, label: 'b' }), [{ t: 110, label: 'b' }]);
  const four = [10, 100, 200].reduce((ms, t) => withMark(ms, { t, label: String(t) }), [] as { t: number; label: string }[]);
  assert.deepEqual(withMark(four, { t: 300, label: '300' }).map((m) => m.t), [100, 200, 300]);
});

test('rangePairs and inRanges', () => {
  const r = { length: 2, start: (i: number) => [0, 50][i], end: (i: number) => [10, 60][i] };
  assert.deepEqual(rangePairs(r, 100), [[100, 110], [150, 160]]);
  assert.equal(inRanges(r, 5), true);
  assert.equal(inRanges(r, 60), true);
  assert.equal(inRanges(r, 30), false);
  assert.equal(inRanges({ length: 0, start: () => 0, end: () => 0 }, 0), false);
});

test('nextPopupAt: the credits when the estimate is any good, else 30 s before the end', () => {
  assert.equal(nextPopupAt({ at: 1200, confidence: 'low' }, 1500), 1200);
  assert.equal(nextPopupAt({ at: 1200, confidence: 'none' }, 1500), 1470);
  assert.equal(nextPopupAt(null, 1500), 1470);
  assert.equal(nextPopupAt(null, 0), 0);
});

test('upNextMode: over the credits only before the end; plays on by itself only when sure, or at the end', () => {
  const base = { ended: false, autoNext: true, sleepEpisode: false };
  assert.deepEqual(upNextMode({ ...base, credits: { at: 1200, confidence: 'high' } }), { credits: true, auto: true });
  assert.deepEqual(upNextMode({ ...base, credits: { at: 1200, confidence: 'low' } }), { credits: true, auto: false });
  assert.deepEqual(upNextMode({ ...base, credits: null }), { credits: false, auto: false });
  assert.deepEqual(upNextMode({ ...base, ended: true, credits: null }), { credits: false, auto: true });
  assert.deepEqual(upNextMode({ ...base, ended: true, credits: null, sleepEpisode: true }), { credits: false, auto: false }, 'the sleep timer stops after this one');
  assert.deepEqual(upNextMode({ ...base, ended: true, credits: null, autoNext: false }), { credits: false, auto: false });
});

test('doubleTapSkip: two quick taps near each other on a side third', () => {
  assert.equal(doubleTapSkip({ t: 1000, x: 0.1 }, { t: 1200, x: 0.12 }), -10);
  assert.equal(doubleTapSkip({ t: 1000, x: 0.9 }, { t: 1200, x: 0.85 }), 10);
  assert.equal(doubleTapSkip({ t: 1000, x: 0.5 }, { t: 1200, x: 0.5 }), null, 'the middle is not a skip');
  assert.equal(doubleTapSkip({ t: 1000, x: 0.1 }, { t: 1400, x: 0.1 }), null, 'too slow');
  assert.equal(doubleTapSkip({ t: 1000, x: 0.1 }, { t: 1200, x: 0.3 }), null, 'too far apart');
});

const track = (id: string, lang: string, o: Partial<SubtitleTrack> = {}): SubtitleTrack => ({ id, lang, label: id, origin: 'addon', url: `/${id}.vtt`, available: true, ...o });

test('bestInLang: recommended, then a hash match, then the first available in that language', () => {
  const ts = [track('a', 'eng'), track('b', 'eng', { hashMatch: true }), track('c', 'eng', { recommended: true }), track('d', 'nor')];
  assert.equal(bestInLang(ts, 'eng')?.id, 'c');
  assert.equal(bestInLang(ts.slice(0, 2), 'eng')?.id, 'b');
  assert.equal(bestInLang([track('x', 'eng', { available: false }), track('a', 'eng')], 'eng')?.id, 'a');
  assert.equal(bestInLang(ts, 'spa'), undefined);
});

test('subToTurnOn: the track used last, else English, else any available', () => {
  const ts = [track('n', 'nor'), track('e', 'eng'), track('g', 'ger', { available: false })];
  assert.equal(subToTurnOn(ts, ts[0])?.id, 'n');
  assert.equal(subToTurnOn(ts, null)?.id, 'e');
  assert.equal(subToTurnOn(ts, track('g', 'ger'))?.id, 'e', 'the last one is not available any more');
  assert.equal(subToTurnOn([track('n', 'nor')], null)?.id, 'n');
  assert.equal(subToTurnOn([], null), undefined);
});

test('stallWaitMs: 18 s once playing started, 35 s before; none when not buffering, failed, open or snoozed', () => {
  const base = { ready: true, err: false, open: false, buffering: true, snoozedUntil: 0, now: 1000, hasPlay: true };
  assert.equal(stallWaitMs(base), 18_000);
  assert.equal(stallWaitMs({ ...base, hasPlay: false }), 35_000);
  assert.equal(stallWaitMs({ ...base, ready: false }), null);
  assert.equal(stallWaitMs({ ...base, err: true }), null);
  assert.equal(stallWaitMs({ ...base, open: true }), null);
  assert.equal(stallWaitMs({ ...base, buffering: false }), null);
  assert.equal(stallWaitMs({ ...base, snoozedUntil: 2000 }), null);
  assert.equal(stallWaitMs({ ...base, snoozedUntil: 1000 }), 18_000);
});
