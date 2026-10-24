import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MetaPreview } from '../server/types.ts';
import { kindCounts, fitKind, ofKind } from '../client/lib/search-kinds.ts';

const m = (id: string, type: MetaPreview['type']): MetaPreview => ({ id, type, name: id });
const mixed = [m('a', 'movie'), m('b', 'series'), m('c', 'movie')];

test('kindCounts: all, movies and series', () => {
  assert.deepEqual(kindCounts(mixed), { all: 3, movie: 2, series: 1 });
  assert.deepEqual(kindCounts([]), { all: 0, movie: 0, series: 0 });
});

test('fitKind: a kind the results hold stays chosen', () => {
  assert.equal(fitKind('series', kindCounts(mixed)), 'series');
  assert.equal(fitKind('all', kindCounts(mixed)), 'all');
});

test('fitKind: a new query with none of the chosen kind falls back to all, so something is shown', () => {
  const movies = [m('a', 'movie'), m('c', 'movie')];
  const kind = fitKind('series', kindCounts(movies));
  assert.equal(kind, 'all');
  assert.equal(ofKind(movies, kind).length, 2);
});

test('fitKind: no results at all is "all" too', () => {
  assert.equal(fitKind('movie', kindCounts([])), 'all');
});

test('ofKind: filters by kind, all keeps every title in order', () => {
  assert.deepEqual(ofKind(mixed, 'movie').map((x) => x.id), ['a', 'c']);
  assert.deepEqual(ofKind(mixed, 'all').map((x) => x.id), ['a', 'b', 'c']);
});
