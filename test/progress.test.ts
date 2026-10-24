import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Progress } from '../server/types.ts';
import { resumePoint, isFinished, minutesLeft, MIN_RESUME_SEC } from '../client/lib/progress.ts';

const p = (pos: number, dur: number): Progress => ({ videoId: 'tt1', metaId: 'tt1', type: 'movie', pos, dur, updatedAt: 0, name: 'A film' });

test('resumePoint: nothing below the 5 second floor', () => {
  assert.equal(MIN_RESUME_SEC, 5);
  assert.equal(resumePoint(undefined), undefined);
  assert.equal(resumePoint(null), undefined);
  assert.equal(resumePoint(p(0, 6000)), undefined);
  assert.equal(resumePoint(p(4.9, 6000)), undefined);
  assert.equal(resumePoint(p(NaN, 6000)), undefined);
  assert.equal(resumePoint(p(5, 6000)), 5);
});

test('resumePoint: the position in the middle, nothing once in the last 5 percent', () => {
  assert.equal(resumePoint(p(1234.5, 6000)), 1234.5);
  assert.equal(resumePoint(p(5400, 6000)), 5400);
  assert.equal(resumePoint(p(5760, 6000)), undefined);
  assert.equal(resumePoint(p(6000, 6000)), undefined);
});

test('resumePoint: an unknown duration still resumes', () => {
  assert.equal(resumePoint(p(300, 0)), 300);
});

test('isFinished: past 95 percent, same rule as the server', () => {
  assert.equal(isFinished(p(95, 100)), false);
  assert.equal(isFinished(p(95.01, 100)), true);
  assert.equal(isFinished(p(100, 100)), true);
  assert.equal(isFinished(p(1, 1)), true, 'marked watched by hand');
  assert.equal(isFinished(p(50, 0)), false);
  assert.equal(isFinished(undefined), false);
  assert.equal(isFinished(null), false);
});

test('resumePoint at exactly 95 percent still resumes, one step past does not', () => {
  assert.equal(resumePoint(p(95, 100)), 95);
  assert.equal(resumePoint(p(95.01, 100)), undefined);
});

test('minutesLeft: rounded minutes, at least 1, 0 without a duration', () => {
  assert.equal(minutesLeft(p(0, 3600)), 60);
  assert.equal(minutesLeft(p(1200, 3600)), 40);
  assert.equal(minutesLeft(p(3570, 3600)), 1);
  assert.equal(minutesLeft(p(3600, 3600)), 1);
  assert.equal(minutesLeft(p(300, 0)), 0);
});
