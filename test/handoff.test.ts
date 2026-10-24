import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMagnetId, metaIdOf, handoffPlayParams, castingEpisode } from '../client/lib/handoff.ts';

test('metaIdOf: an episode belongs to its show, a movie to itself, a magnet file to its torrent', () => {
  assert.equal(metaIdOf('tt0903747:2:3'), 'tt0903747');
  assert.equal(metaIdOf('tt0111161'), 'tt0111161');
  assert.equal(metaIdOf('magnet:abc123:4'), 'magnet:abc123');
});

test('isMagnetId: only magnet files', () => {
  assert.equal(isMagnetId('magnet:abc:0'), true);
  assert.equal(isMagnetId('tt1:1:1'), false);
  assert.equal(isMagnetId(undefined), false);
});

const h = { pos: 612.5, infoHash: 'abc', fileIdx: 2, title: 'Pilot', poster: 'p.jpg' };

test('handoffPlayParams: the kind comes from the cast status, never from the id shape', () => {
  const p = handoffPlayParams('series', { ...h, videoId: 'tt0903747:1:1' });
  assert.deepEqual(p, { type: 'series', videoId: 'tt0903747:1:1', metaId: 'tt0903747', infoHash: 'abc', fileIdx: 2, name: 'Pilot', poster: 'p.jpg', t: 612.5, magnet: undefined });
  assert.equal(handoffPlayParams('movie', { ...h, videoId: 'tt0111161' }).type, 'movie');
  assert.equal(handoffPlayParams(undefined, { ...h, videoId: 'tt0111161' }).type, 'movie', 'no kind known: a movie');
});

test('handoffPlayParams: a magnet file resumes as a magnet play with its torrent as the title', () => {
  const p = handoffPlayParams('movie', { ...h, videoId: 'magnet:abc:2' });
  assert.equal(p.type, 'movie');
  assert.equal(p.metaId, 'magnet:abc');
  assert.equal(p.magnet, true);
});

test('handoffPlayParams: no video id still plays the file', () => {
  const p = handoffPlayParams('movie', h);
  assert.equal(p.videoId, '');
  assert.equal(p.metaId, '');
  assert.equal(p.infoHash, 'abc');
  assert.equal(p.fileIdx, 2);
});

test('castingEpisode: a series episode by the cast kind, never by the id shape', () => {
  const ep = { active: true, type: 'series' as const, videoId: 'tt0903747:1:2' };
  assert.equal(castingEpisode(ep), 'tt0903747:1:2');
  assert.equal(castingEpisode({ ...ep, type: 'movie' }), null, 'colon in the id but the status says movie');
  assert.equal(castingEpisode({ ...ep, type: undefined }), null, 'kind unknown: no episode');
  assert.equal(castingEpisode({ ...ep, active: false }), null);
  assert.equal(castingEpisode({ ...ep, videoId: 'magnet:abc:3' }), null);
  assert.equal(castingEpisode({ ...ep, videoId: undefined }), null);
});

test('episodeOf: season and episode from an episode id, nothing for a movie or a magnet file', async () => {
  const { episodeOf } = await import('../client/lib/handoff.ts');
  assert.deepEqual(episodeOf('tt1910272:1:17'), { season: 1, episode: 17 });
  assert.equal(episodeOf('tt0111161'), null);
  assert.equal(episodeOf('magnet:abc:4'), null);
  assert.equal(episodeOf(undefined), null);
});

test('nowPlayingParams: the player in its TV mode for a file on the TV, nothing when no cast', async () => {
  const { nowPlayingParams } = await import('../client/lib/handoff.ts');
  const c = { active: true, type: 'series' as const, videoId: 'tt1910272:1:17', infoHash: 'abc', fileIdx: 16, title: 'Steins;Gate S1 E17', poster: 'p.jpg' };
  assert.deepEqual(nowPlayingParams(c), { type: 'series', videoId: 'tt1910272:1:17', metaId: 'tt1910272', infoHash: 'abc', fileIdx: 16, name: 'Steins;Gate S1 E17', poster: 'p.jpg', season: 1, episode: 17, magnet: undefined, tv: true });
  assert.equal(nowPlayingParams({ ...c, active: false }), null);
  assert.equal(nowPlayingParams({ ...c, videoId: 'magnet:abc:0' })?.magnet, true);
});
