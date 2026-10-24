import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitShowName, groupNewEpisodes, airLabel } from '../client/components/home-data.ts';
import type { Episode, MetaPreview } from '../server/types.ts';

test('splitShowName separates show and episode title', () => {
  assert.deepEqual(splitShowName("Harbor S1 E5 The Keeper's Son"), { show: 'Harbor', episode: "The Keeper's Son" });
  assert.deepEqual(splitShowName('Harbor S1 E5'), { show: 'Harbor', episode: '' });
  assert.deepEqual(splitShowName('Common Side Effects S1E1 Pilot'), { show: 'Common Side Effects', episode: 'Pilot' });
  assert.deepEqual(splitShowName('Big Buck Bunny'), { show: 'Big Buck Bunny', episode: '' });
});

test('groupNewEpisodes stacks per show, newest first, keeps show order of first appearance', () => {
  const harbor: MetaPreview = { id: 'tt1', type: 'series', name: 'Harbor' };
  const lasso: MetaPreview = { id: 'tt2', type: 'series', name: 'Ted Lasso' };
  const ep = (s: number, e: number): Episode => ({ id: `x:${s}:${e}`, season: s, episode: e, title: `E${e}` });
  const out = groupNewEpisodes([
    { show: harbor, episode: ep(3, 9) }, { show: lasso, episode: ep(4, 1) }, { show: harbor, episode: ep(3, 10) }, { show: harbor, episode: ep(2, 10) },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].show.id, 'tt1');
  assert.deepEqual(out[0].episodes.map((e) => e.id), ['x:3:10', 'x:3:9', 'x:2:10']);
  assert.deepEqual(out[1].episodes.map((e) => e.id), ['x:4:1']);
});

test('airLabel: today, tomorrow, a weekday within the week, a date after that', () => {
  const now = new Date(2026, 8, 24, 20, 0).getTime();   // Thursday evening, local time
  const at = (m: number, d: number, h = 9) => new Date(2026, m, d, h).toISOString();
  assert.equal(airLabel(at(8, 24, 23), now), 'Today');
  assert.equal(airLabel(at(8, 25, 1), now), 'Tomorrow', 'after midnight is tomorrow, however close');
  assert.equal(airLabel(at(8, 28), now), 'Monday');
  assert.equal(airLabel(at(8, 30), now), 'Wednesday');
  assert.equal(airLabel(at(9, 1), now), '1 Oct', 'a week away is a date');
  assert.equal(airLabel(undefined, now), '');
});
