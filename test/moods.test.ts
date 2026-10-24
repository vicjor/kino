import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOODS, moodUrl, browseUrl, browseTitle } from '../client/components/moods.ts';

test('browseUrl keeps the route short and the filters in the query', () => {
  assert.equal(browseUrl('all'), '/browse/all');
  assert.equal(browseUrl('series', { genre: 'Sci-Fi' }), '/browse/series?genre=Sci-Fi');
  assert.equal(browseUrl('movie', { genre: 'Horror', sort: 'rated' }), '/browse/movie?genre=Horror&sort=rated');
  assert.equal(browseUrl('all', { sort: 'top' }), '/browse/all');
  assert.equal(browseUrl('movie', { sort: 'rated', from: 2020, to: 2024 }), '/browse/movie?sort=rated&from=2020&to=2024');
});

test('browseTitle reads like a shelf label', () => {
  assert.equal(browseTitle('all'), 'Popular movies and series');
  assert.equal(browseTitle('series', 'Thriller'), 'Thriller series');
  assert.equal(browseTitle('movie', 'Comedy', 'rated'), 'Top rated comedy movies');
  assert.equal(browseTitle('series', undefined, 'top', 'from the 2010s'), 'Popular series from the 2010s');
  assert.equal(browseTitle('all', undefined, 'new'), 'New movies and series');
});

test('every mood lands on a Browse page with a distinct key', () => {
  assert.equal(new Set(MOODS.map((m) => m.key)).size, MOODS.length);
  for (const m of MOODS) assert.match(moodUrl(m), /^\/browse\/(all|movie|series)/);
});
