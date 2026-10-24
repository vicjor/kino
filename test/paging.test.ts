import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageAfter } from '../client/lib/paging.ts';

test('pageAfter: a slow drag past halfway turns the page, a short one springs back', () => {
  assert.equal(pageAfter(-260, 440, 0, 0, 5), 1);
  assert.equal(pageAfter(-150, 440, 0, 0, 5), 0);
});

test('pageAfter: a flick carries on, but never more than one page, and never past either end', () => {
  assert.equal(pageAfter(-60, 440, -2000, 0, 5), 1, 'a quick flick from the first slide');
  assert.equal(pageAfter(-460, 440, -9000, 1, 5), 2, 'one page per flick');
  assert.equal(pageAfter(-1780, 440, -3000, 4, 5), 4, 'the last slide stays the last');
  assert.equal(pageAfter(40, 440, 3000, 0, 5), 0, 'the first stays the first');
});
