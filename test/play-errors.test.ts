import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorCode } from '../server/types.ts';
import { codeWords, startWords, stoppedWords, toastWords, sharing, sharingNow, endedEarlyWords, endedEarlyDetail, waitWords, stallWords, slowWords, stutterWords, autoRetry, MEDIA } from '../client/lib/play-errors.ts';

// client/lib/play-errors.ts: the player's failure and stall copy, chosen by the server's code, in plain words.

const CODES: ErrorCode[] = ['no-peers', 'unreadable', 'disk-full', 'tool-broken', 'transcode-failed', 'session-gone'];
/** Words a person watching a film should never have to read. */
const JARGON = /transcod|ffmpeg|ffprobe|\bpeers?\b|seed|H\.?264|evict|metadata|session/i;
const GB = 1024 ** 3;
const play = (o: { mode?: 'direct' | 'hls-copy' | 'hls-transcode'; sizeBytes?: number; duration?: number } = {}) => ({ mode: o.mode ?? 'direct', sizeBytes: o.sizeBytes ?? 2 * GB, probe: { duration: o.duration ?? 3600 } });
const stats = (numPeers: number, downloadSpeed: number) => ({ numPeers, downloadSpeed });

test('codeWords: every server code has words, an unknown or missing one has none', () => {
  for (const c of CODES) assert.ok(codeWords(c)?.msg, c);
  for (const c of [undefined, '', 'ENOENT', 'toString', 'some-new-code']) assert.equal(codeWords(c), undefined, String(c));
});

test('startWords: chosen by code, never by the server text; no code is a plain line', () => {
  assert.equal(startWords('no-peers').msg, 'Could not fetch this file');
  assert.equal(startWords('unreadable').msg, 'Could not fetch this file');
  assert.equal(startWords('disk-full').msg, 'Not enough disk space');
  assert.equal(startWords('tool-broken').msg, 'Kino cannot play videos right now');
  assert.deepEqual(startWords(undefined), { msg: 'Could not start playback' });
  assert.deepEqual(startWords('a-code-from-a-newer-server'), { msg: 'Could not start playback' });
});

test('stoppedWords: a full disk and a broken program say so; any other stop is the conversion stopping', () => {
  assert.equal(stoppedWords('disk-full').msg, 'Not enough disk space');
  assert.equal(stoppedWords('tool-broken').msg, 'Kino cannot play videos right now');
  for (const c of ['transcode-failed', undefined]) {
    const w = stoppedWords(c);
    assert.equal(w.msg, 'Kino stopped converting this video');
    assert.match(w.hint!, /from where you were/);
  }
});

test('toastWords: the code\'s words in one line, else the server\'s own', () => {
  assert.equal(toastWords('session-gone', 'session gone'), 'Kino stopped this stream. Trying again picks up from where you were.');
  assert.equal(toastWords(undefined, 'Could not reach Kino. Is the Mac awake and on the network?'), 'Could not reach Kino. Is the Mac awake and on the network?');
});

test('sharing: one person, several people', () => {
  assert.equal(sharing(1), '1 person sharing it');
  assert.equal(sharing(0), '0 people sharing it');
  assert.equal(sharing(12), '12 people sharing it');
});

test('sharingNow: the download line under the player, nobody when nobody', () => {
  assert.equal(sharingNow(0), 'Nobody sharing it');
  assert.equal(sharingNow(1), '1 person sharing it');
  assert.equal(sharingNow(7), '7 people sharing it');
});

test('autoRetry: a full disk or a broken program is shown at once; anything else may be retried quietly', () => {
  assert.equal(autoRetry('disk-full'), false);
  assert.equal(autoRetry('tool-broken'), false);
  for (const c of ['no-peers', 'unreadable', 'transcode-failed', 'session-gone', 'some-new-code', undefined]) assert.equal(autoRetry(c), true, String(c));
});

test('MEDIA: every failure the browser reports has a line', () => {
  for (const [k, w] of Object.entries(MEDIA)) assert.ok(w.msg, k);
  assert.match(MEDIA.broken.hint, /Another source/);
  assert.match(stutterWords(true).reason, /same episode\.$/);
  assert.match(stutterWords(false).reason, /same film\.$/);
});

test('endedEarlyWords: the download ran dry on direct play, the conversion stopped otherwise', () => {
  assert.match(endedEarlyWords(true).hint!, /download could not keep up/);
  assert.match(endedEarlyWords(false).hint!, /Converting the video most likely stopped/);
  assert.equal(endedEarlyDetail(600, 3600, null), 'Stopped at 10:00 of 1:00:00');
  assert.match(endedEarlyDetail(600, 3600, stats(3, 1024 * 1024)), /^Stopped at 10:00 of 1:00:00 · 3 people sharing it · /);
});

test('waitWords: what the spinner says while it loads and while it waits', () => {
  assert.equal(waitWords(true, null, null), 'Starting…');
  assert.equal(waitWords(true, null, stats(0, 0)), 'Looking for people sharing it…');
  assert.equal(waitWords(true, null, stats(1, 0)), 'Connecting to 1 person sharing it…');
  assert.equal(waitWords(false, null, null), 'Looking for people sharing it…');
  assert.equal(waitWords(false, play(), stats(0, 0)), 'Waiting for someone to share it…');
  assert.equal(waitWords(false, play(), stats(4, 0)), 'Buffering');
  assert.equal(waitWords(false, play(), null), 'Buffering');
});

test('stallWords: nobody sharing, too slow for the file, conversion behind, or the file itself', () => {
  assert.match(stallWords(null, null).reason, /^Still looking for people sharing this file/);
  assert.equal(stallWords(play(), null).reason, 'Nobody is sharing this file right now.', 'no numbers yet counts as nobody');
  assert.equal(stallWords(play(), stats(0, 5e6)).reason, 'Nobody is sharing this file right now.');
  // 2 GB in an hour needs about 0.6 MB/s.
  const slow = stallWords(play(), stats(2, 100_000));
  assert.match(slow.reason, /^Getting .* from 2 people sharing it, but this 2(\.0)? GB file needs about .* to play smoothly\.$/);
  assert.equal(slow.hint, 'Too few people are sharing this one right now.');
  assert.match(stallWords(play({ sizeBytes: 8 * GB }), stats(2, 100_000)).hint!, /^It is a big file/);
  assert.match(stallWords(play({ mode: 'hls-transcode' }), stats(9, 5e6)).reason, /converting the video for this screen cannot keep up/);
  assert.equal(stallWords(play({ mode: 'hls-copy' }), stats(9, 5e6)).reason, 'The download looks fine, but playback keeps stopping.');
});

test('slowWords: the nudge when the download falls behind the video', () => {
  assert.deepEqual(slowWords(0, 0, 1e6), { text: 'Nobody is sharing this source', reason: 'Nobody is sharing this source right now.' });
  const w = slowWords(3, 200_000, 600_000);
  assert.equal(w.text, 'Download slower than the video');
  assert.match(w.reason, /^Only .* from 3 people sharing it; this file needs about .*\.$/);
});

test('none of the copy says ffmpeg, transcoder, peers, seeders, H.264, session, release or decode', () => {
  const all = [
    ...CODES.flatMap((c) => [startWords(c), stoppedWords(c)]), startWords(undefined), stoppedWords(undefined), endedEarlyWords(true), endedEarlyWords(false),
  ].flatMap((w) => [w.msg, w.hint ?? '']);
  const states = [null, play(), play({ mode: 'hls-transcode' }), play({ sizeBytes: 8 * GB })];
  const counts = [null, stats(0, 0), stats(1, 100), stats(5, 1e8)];
  for (const p of states) for (const s of counts) { const w = stallWords(p, s); all.push(w.reason, w.hint ?? '', waitWords(true, p, s), waitWords(false, p, s)); }
  for (const n of [0, 1, 3]) { const w = slowWords(n, 100, 1e6); all.push(w.text, w.reason); }
  all.push(endedEarlyDetail(1, 2, stats(2, 100)), sharingNow(0), sharingNow(4));
  for (const w of [...Object.values(MEDIA), stutterWords(true), stutterWords(false)]) all.push(...Object.values(w));
  for (const line of all) assert.doesNotMatch(line, JARGON, line);
  for (const line of all) assert.doesNotMatch(line, /\brelease|decod/i, line);
});
