import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabWrap } from '../client/lib/focus.ts';

test('tabWrap: Tab on the last stop wraps to the first, Shift+Tab on the first wraps to the last', () => {
  assert.equal(tabWrap(2, 3, false), 0);
  assert.equal(tabWrap(0, 3, true), 2);
});

test('tabWrap: in the middle the browser moves focus itself', () => {
  assert.equal(tabWrap(0, 3, false), null);
  assert.equal(tabWrap(1, 3, false), null);
  assert.equal(tabWrap(1, 3, true), null);
  assert.equal(tabWrap(2, 3, true), null);
});

test('tabWrap: focus on the dialog itself or lost goes to the first stop, or the last going back', () => {
  assert.equal(tabWrap(-1, 3, false), 0);
  assert.equal(tabWrap(-1, 3, true), 2);
});

test('tabWrap: a dialog with nothing to stop on keeps focus on itself', () => {
  assert.equal(tabWrap(-1, 0, false), -1);
  assert.equal(tabWrap(-1, 0, true), -1);
});

test('tabWrap: a single stop keeps focus on it both ways', () => {
  assert.equal(tabWrap(0, 1, false), 0);
  assert.equal(tabWrap(0, 1, true), 0);
});
