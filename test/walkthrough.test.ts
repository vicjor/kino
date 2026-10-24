import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowWalkthrough } from '../client/lib/walkthrough.ts';

const fresh = { onboarded: false };
const done = { onboarded: true };

test('shouldShowWalkthrough: Home with no route parts opens it while setup is not done', () => {
  assert.equal(shouldShowWalkthrough({ parts: [] }, fresh), true);
});

test('shouldShowWalkthrough: Home with an empty first part counts as Home', () => {
  assert.equal(shouldShowWalkthrough({ parts: [''] }, fresh), true);
});

test('shouldShowWalkthrough: other screens open what they point at, even before setup is done', () => {
  for (const parts of [['title', 'movie', 'tt1'], ['play'], ['settings'], ['library'], ['search'], ['browse', 'movie'], ['live', 'play']]) {
    assert.equal(shouldShowWalkthrough({ parts }, fresh), false, parts.join('/'));
  }
});

test('shouldShowWalkthrough: an install that finished setup never sees it on its own', () => {
  assert.equal(shouldShowWalkthrough({ parts: [] }, done), false);
  assert.equal(shouldShowWalkthrough({ parts: [''] }, done), false);
  assert.equal(shouldShowWalkthrough({ parts: ['settings'] }, done), false);
});

test('shouldShowWalkthrough: no answer yet (older settings, or settings still loading) shows nothing', () => {
  assert.equal(shouldShowWalkthrough({ parts: [] }, {}), false);
  assert.equal(shouldShowWalkthrough({ parts: [] }, null), false);
  assert.equal(shouldShowWalkthrough({ parts: [] }, undefined), false);
});

test('shouldShowWalkthrough: /welcome replays it, onboarded or not, once settings are here', () => {
  assert.equal(shouldShowWalkthrough({ parts: ['welcome'] }, done), true);
  assert.equal(shouldShowWalkthrough({ parts: ['welcome'] }, fresh), true);
  assert.equal(shouldShowWalkthrough({ parts: ['welcome'] }, null), false);
});
