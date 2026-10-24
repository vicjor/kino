import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAiring, comingUp } from '../server/upcoming.ts';
import type { Episode, MetaPreview } from '../server/types.ts';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const ep = (season: number, episode: number, released?: string): Episode => ({ id: `tt1:${season}:${episode}`, season, episode, title: `E${episode}`, released });
const show = (id: string): MetaPreview => ({ id, type: 'series', name: id });
const weekly = [ep(6, 1, '2026-09-16T00:00:00.000Z'), ep(6, 2, '2026-09-23T00:00:00.000Z'), ep(6, 3, '2026-09-30T00:00:00.000Z'), ep(6, 4, '2026-10-07T00:00:00.000Z'), ep(6, 5, '2026-10-14T00:00:00.000Z')];

test('nextAiring: the first episode still to come, and how many of the season follow', () => {
  assert.deepEqual(nextAiring(weekly, NOW), { episode: weekly[2], more: 2 });
  assert.equal(nextAiring(weekly.slice(0, 2), NOW), undefined, 'season fully out');
  assert.equal(nextAiring([ep(7, 1, '2027-06-01T00:00:00.000Z')], NOW), undefined, 'too far off to be worth a card');
  assert.equal(nextAiring([ep(0, 9, '2026-09-26T00:00:00.000Z')], NOW), undefined, 'specials do not count');
  assert.equal(nextAiring([ep(1, 1)], NOW), undefined, 'no date, no card');
  assert.equal(nextAiring(undefined, NOW), undefined);
});

test('comingUp: one card per show, soonest first', () => {
  const later = [ep(29, 2, '2026-10-01T00:00:00.000Z')].map((e) => ({ ...e, id: 'tt2:29:2' }));
  const r = comingUp([{ show: show('tt2'), videos: later }, { show: show('tt1'), videos: weekly }, { show: show('tt1'), videos: weekly }, { show: show('tt3'), videos: [] }], NOW);
  assert.deepEqual(r.map((x) => `${x.show.id} S${x.episode.season}E${x.episode.episode}`), ['tt1 S6E3', 'tt2 S29E2']);
});
