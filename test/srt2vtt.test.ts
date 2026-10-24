import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, decodeSubtitle, parseSrt, parseVtt, parseTs, toVtt, fmtTs, vttToSrt } from '../server/subs/srt2vtt.ts';

const SRT = `1\r\n00:00:01,000 --> 00:00:03,500\r\nHei <font color="red">verden</font>\r\n\r\n2\r\n00:01:00,250 --> 00:01:02,000\r\nLine one\r\nLine two\r\n\r\n`;

test('srt -> vtt', () => {
  const v = convert(SRT);
  assert.ok(v.startsWith('WEBVTT\n'));
  assert.match(v, /00:00:01\.000 --> 00:00:03\.500\nHei verden/);
  assert.match(v, /00:01:00\.250 --> 00:01:02\.000\nLine one\nLine two/);
});

test('offset shifts and drops cues before zero', () => {
  const v = convert(SRT, -2000);
  assert.match(v, /00:00:00\.000 --> 00:00:01\.500\nHei verden/); // clamped, not dropped
  assert.match(v, /00:00:58\.250 --> 00:01:00\.000/);
  const v2 = convert(SRT, 500);
  assert.match(v2, /00:00:01\.500 --> 00:00:04\.000/);
});

test('vtt passthrough re-timed', () => {
  const v = convert('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nx\n', 1000);
  assert.match(v, /00:00:06\.000 --> 00:00:07\.000\nx/);
});

test('decode utf8 bom, cp1252 fallback, hint', () => {
  assert.equal(decodeSubtitle(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'A');
  const latin = Buffer.from([0xe6, 0xf8, 0xe5]); // æøå in cp1252
  assert.equal(decodeSubtitle(latin), 'æøå');
  assert.equal(decodeSubtitle(Buffer.from('æøå', 'utf8')), 'æøå');
  assert.equal(decodeSubtitle(latin, 'CP1252'), 'æøå');
});

test('parse tolerates missing index and short ms', () => {
  const c = parseSrt('00:00:01,5 --> 00:00:02,50\nhi\n');
  assert.equal(c.length, 1);
  assert.equal(c[0].start, 1500);
  assert.equal(c[0].end, 2500);
  assert.equal(fmtTs(3661001), '01:01:01.001');
  assert.equal(toVtt([]), 'WEBVTT\n');
});

test('vtt -> srt for DLNA renderers, numbered, comma millis, offset applied, tags stripped', () => {
  const srt = vttToSrt('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<i>Hei</i> verden\n\n00:01:00.250 --> 00:01:02.000\nLine\n', 500);
  assert.match(srt, /^1\r\n00:00:01,500 --> 00:00:04,000\r\nHei verden\r\n\r\n2\r\n00:01:00,750 --> 00:01:02,500\r\nLine/);
});

test('hourless vtt (ffmpeg webvtt muxer below 1:00:00) keeps every cue', () => {
  const v = convert('WEBVTT\n\n00:01.000 --> 00:02.500\nOne\n\n00:59.5 --> 01:00.000\nTwo\n\n59:59.999 --> 01:00:00.500\nThree\n');
  assert.equal(v, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nOne\n\n00:00:59.500 --> 00:01:00.000\nTwo\n\n00:59:59.999 --> 01:00:00.500\nThree\n');
});

test('mixed hour and hourless vtt, settings after the end time, cue ids kept', () => {
  const c = parseVtt('WEBVTT\n\nNOTE made by hand\n\nintro\n00:05.000 --> 00:06.000 align:start line:0\nHi\n\n01:02:03.004 --> 01:02:04.000\nLate\n');
  assert.deepEqual(c.map((x) => [x.start, x.end, x.text]), [[5000, 6000, 'Hi'], [3723004, 3724000, 'Late']]);
  assert.match(convert('﻿WEBVTT\n\n00:05.000 --> 00:06.000\nBom\n'), /^WEBVTT\n\n00:00:05\.000 --> 00:00:06\.000\nBom/);
});

test('srt timestamps unchanged: comma millis, one digit hour, no millis or leading junk rejected', () => {
  assert.equal(parseTs('00:00:01,000'), 1000);
  assert.equal(parseTs('1:02:03,4'), 3723400);
  assert.equal(parseTs(' 10:00:00.000 '), 36_000_000);
  assert.ok(Number.isNaN(parseTs('00:01:02')));
  assert.ok(Number.isNaN(parseTs('x 00:00:01,000')));
  assert.deepEqual(parseSrt(SRT).map((x) => [x.start, x.end]), [[1000, 3500], [60250, 62000]]);
});
