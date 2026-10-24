import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVtt, cueLineFor } from '../client/lib/vtt.ts';

const cues = (s: string) => parseVtt(s).map((c) => [c.start, c.end, c.text]);

test('client vtt: hours and hourless both parse, in seconds', () => {
  assert.deepEqual(cues('WEBVTT\n\n00:01.000 --> 00:02.500\nOne\n\n01:02:03.250 --> 01:02:04.000\nTwo\n'), [[1, 2.5, 'One'], [3723.25, 3724, 'Two']]);
});

test('client vtt: comma millis, short millis, cue settings after the end time', () => {
  assert.deepEqual(cues('WEBVTT\n\n00:00:05,5 --> 00:00:06,000 align:start position:10%\nHi\n'), [[5.5, 6, 'Hi']]);
});

test('client vtt: cue ids, NOTE and STYLE blocks, BOM, CRLF', () => {
  const v = '﻿WEBVTT - Kino\r\n\r\nNOTE a comment\r\nover two lines\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nintro\r\n00:01.000 --> 00:02.000\r\nA\r\n\r\n2\r\n00:03.000 --> 00:04.000\r\nB\r\n';
  assert.deepEqual(cues(v), [[1, 2, 'A'], [3, 4, 'B']]);
});

test('client vtt: inline tags stripped, multi-line text kept, bad timing dropped', () => {
  assert.deepEqual(cues('WEBVTT\n\n00:01.000 --> 00:02.000\n<i>Hei</i> <c.yellow>verden</c>\nline two\n\nnot a time --> 00:05.000\nx\n'), [[1, 2, 'Hei verden\nline two']]);
});

test('cueLineFor: up out of the way only when the controls cover the picture, close to the edge of a small one', () => {
  assert.equal(cueLineFor(true, true, 900), -6);
  assert.equal(cueLineFor(false, true, 900), -3);
  assert.equal(cueLineFor(true, false, 226), -2, 'upright phone: the controls are below the picture');
  assert.equal(cueLineFor(false, false, 226), -2);
});
