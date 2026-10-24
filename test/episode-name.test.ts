import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeCode, episodeName } from '../server/episode-name.ts';
import { episodeCode as clientEpisodeCode } from '../client/lib/format.ts';
import { splitShowName } from '../client/components/home-data.ts';
import { showName } from '../server/taste.ts';

test('episodeCode: "S2 E3", one function for the client and the server', () => {
  assert.equal(episodeCode(2, 3), 'S2 E3');
  assert.equal(episodeCode(0, 1), 'S0 E1', 'specials keep season 0');
  assert.equal(episodeCode(1, 120), 'S1 E120');
  assert.equal(clientEpisodeCode, episodeCode, 'client/lib/format.ts hands out the same function');
});

test('episodeName: "Show S2 E3 Title", nothing missing shows as a gap or "undefined"', () => {
  assert.equal(episodeName('Harbor', 2, 3, 'Solo'), 'Harbor S2 E3 Solo');
  assert.equal(episodeName('Harbor', 2, 3), 'Harbor S2 E3', 'no title, no trailing space');
  assert.equal(episodeName('Harbor', 2, 3, ''), 'Harbor S2 E3');
  assert.equal(episodeName('Harbor', 2, 3, '  '), 'Harbor S2 E3');
  assert.equal(episodeName(undefined, 2, 3, 'Solo'), 'S2 E3 Solo', 'no show name, no leading space');
  assert.equal(episodeName('', 0, 1, 'Special'), 'S0 E1 Special');
  assert.equal(episodeName(' Harbor ', 1, 10, ' The Keeper\'s Son '), 'Harbor S1 E10 The Keeper\'s Son');
});

test('episodeName: Home and the history split it back into show and episode title', () => {
  assert.deepEqual(splitShowName(episodeName('Ted Lasso', 4, 1, 'Home')), { show: 'Ted Lasso', episode: 'Home' });
  assert.deepEqual(splitShowName(episodeName('Ted Lasso', 4, 1)), { show: 'Ted Lasso', episode: '' });
  assert.equal(showName(episodeName('The Neighbours', 2, 5, 'Title')), 'The Neighbours');
});
