import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromChapters, fromSubtitles, fromLearned, estimateCredits, pushLearned, median } from '../server/media/credits.ts';

const D = 3000;

test('fromChapters: a named credits chapter wins, else a late last chapter', () => {
  assert.deepEqual(fromChapters([{ start: 0, end: 100 }, { start: 100, end: 2800, title: 'Act 2' }, { start: 2800, end: 3000, title: 'End Credits' }], D), { at: 2800, confidence: 'high' });
  assert.deepEqual(fromChapters([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2700, end: 3000 }], D), { at: 2700, confidence: 'medium' });
  assert.equal(fromChapters([{ start: 0, end: 1500 }, { start: 1500, end: 3000 }], D), undefined, 'two halves are not credits');
  assert.equal(fromChapters([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2990, end: 3000 }], D), undefined, 'ten seconds is not a credits chapter');
  assert.equal(fromChapters([{ start: 100, end: 200, title: 'Opening credits' }, { start: 200, end: 3000 }], D), undefined, 'opening credits are in the first half');
});

test('fromSubtitles: last line plus two seconds, only within a sensible tail', () => {
  assert.deepEqual(fromSubtitles(2900, D), { at: 2902, confidence: 'medium' });
  assert.deepEqual(fromSubtitles(2300, D), { at: 2302, confidence: 'low' });
  assert.equal(fromSubtitles(2990, D), undefined, 'dialogue to the end');
  assert.equal(fromSubtitles(1000, D), undefined, 'a subtitle file that stops early is not credits');
});

test('fromLearned: median of earlier presses, high with two or more', () => {
  assert.deepEqual(fromLearned([90, 110], D), { at: 2900, confidence: 'high' });
  assert.deepEqual(fromLearned([120], D), { at: 2880, confidence: 'low' });
  assert.equal(fromLearned([2000], D), undefined, 'half the film is not a credits offset');
  assert.equal(median([1, 5, 3]), 3); assert.equal(median([1, 4]), 2.5);
});

test('estimateCredits: priority order and the empty case', () => {
  assert.equal(estimateCredits({ duration: D, chapters: [{ start: 0, end: 2000 }, { start: 2000, end: 2700 }, { start: 2700, end: 3000, title: 'Credits' }], learnedOffsets: [90, 100] }).source, 'learned');
  assert.equal(estimateCredits({ duration: D, chapters: [{ start: 0, end: 2000 }, { start: 2000, end: 2700 }, { start: 2700, end: 3000, title: 'Credits' }], learnedOffsets: [90] }).source, 'chapter');
  assert.equal(estimateCredits({ duration: D, lastCueEndSec: 2900, learnedOffsets: [90] }).source, 'subtitles');
  assert.equal(estimateCredits({ duration: D, learnedOffsets: [90] }).source, 'learned');
  assert.deepEqual(estimateCredits({ duration: D }), { source: 'none', confidence: 'none' });
});

test('pushLearned keeps the last five', () => {
  assert.deepEqual(pushLearned([1, 2, 3, 4, 5], 6.4), [2, 3, 4, 5, 6]);
  assert.deepEqual(pushLearned(undefined, 90), [90]);
});
