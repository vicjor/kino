import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_FIRST, choosableLangs, toggleLang } from '../client/lib/sub-langs.ts';

const ALL = ['eng', 'nor', 'swe', 'dan'];

test('sub-langs: English is always first, so it is never a chip to tap', () => {
  assert.equal(ALWAYS_FIRST, 'eng');
  assert.deepEqual(choosableLangs(['eng', 'nor'], ALL), ['nor', 'swe', 'dan']);
  assert.deepEqual(choosableLangs([], ALL), ['nor', 'swe', 'dan']);
});

test('sub-langs: chosen languages lead in the order they were tapped', () => {
  assert.deepEqual(choosableLangs(['dan', 'eng', 'nor'], ALL), ['dan', 'nor', 'swe']);
  assert.deepEqual(choosableLangs(['ita'], ALL), ['ita', 'nor', 'swe', 'dan'], 'a language from Settings outside the list still shows');
});

test('sub-langs: a tap turns a language off, or adds it at the end', () => {
  assert.deepEqual(toggleLang(['eng', 'nor'], 'nor'), ['eng']);
  assert.deepEqual(toggleLang(['eng', 'nor'], 'swe'), ['eng', 'nor', 'swe']);
  assert.deepEqual(toggleLang([], 'dan'), ['dan']);
});

test('sub-langs: English stays saved exactly as it was', () => {
  assert.deepEqual(toggleLang(['eng', 'nor'], 'eng'), ['eng', 'nor']);
  assert.deepEqual(toggleLang(['nor'], 'eng'), ['nor'], 'never added either');
  assert.deepEqual(toggleLang(['nor', 'eng'], 'swe'), ['nor', 'eng', 'swe'], 'position kept');
});
