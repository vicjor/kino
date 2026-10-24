import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabMove } from '../client/lib/tabs.ts';

test('tabMove: Right and Left step one tab and wrap at either end', () => {
  assert.equal(tabMove('ArrowRight', 0, 3), 1);
  assert.equal(tabMove('ArrowRight', 2, 3), 0);
  assert.equal(tabMove('ArrowLeft', 1, 3), 0);
  assert.equal(tabMove('ArrowLeft', 0, 3), 2);
});

test('tabMove: Home and End jump to the first and last tab', () => {
  assert.equal(tabMove('Home', 2, 3), 0);
  assert.equal(tabMove('End', 0, 3), 2);
});

test('tabMove: other keys, and focus outside the tabs, are left alone', () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) assert.equal(tabMove(k, 1, 3), null, k);
  assert.equal(tabMove('ArrowRight', -1, 3), null);
  assert.equal(tabMove('ArrowRight', 3, 3), null);
  assert.equal(tabMove('Home', 0, 0), null);
});

test('tabMove: a single tab stays put', () => {
  assert.equal(tabMove('ArrowRight', 0, 1), 0);
  assert.equal(tabMove('ArrowLeft', 0, 1), 0);
});
