import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanBase, mediaTypeOf, persistCast, pickSubtitle } from '../server/cast/common.ts';
import { getProgress } from '../server/store.ts';
import { PORT } from '../server/config.ts';
import { probeKey, localFileUrl } from '../server/media/range.ts';

test('mediaTypeOf: an episode id is a series; a film id, a magnet link or none is a movie', () => {
  assert.equal(mediaTypeOf('tt123:1:2'), 'series');
  assert.equal(mediaTypeOf('tt123'), 'movie');
  assert.equal(mediaTypeOf('magnet:?xt=urn:btih:abc'), 'movie');
  assert.equal(mediaTypeOf(undefined), 'movie');
});

test('lanBase, probeKey and localFileUrl: the URLs and the cache key a cast hands out and probes by', () => {
  assert.match(lanBase(), new RegExp(`^http://[^/:]+:${PORT}$`));
  assert.equal(probeKey('a'.repeat(40), 3), `${'a'.repeat(40)}:3`);
  assert.equal(localFileUrl('a'.repeat(40), 3), `http://127.0.0.1:${PORT}/api/file/${'a'.repeat(40)}/3`);
});

test('pickSubtitle: asked, then saved, then the language carried over unless saved as off', () => {
  const tracks = [{ id: 'en1', lang: 'eng' }, { id: 'fr1', lang: 'fre' }, { id: 'fr2', lang: 'fre' }];
  assert.equal(pickSubtitle(tracks, 'fr2', { subId: 'en1' }, 'fre'), 'fr2', 'asked for and there');
  assert.equal(pickSubtitle(tracks, 'gone', { subId: 'en1' }), 'en1', 'asked for but gone: the saved one');
  assert.equal(pickSubtitle(tracks, undefined, { subId: 'gone' }, 'fre'), 'fr1', 'the first in the language carried over');
  assert.equal(pickSubtitle(tracks, undefined, { subId: null }, 'fre'), undefined, 'saved as off stays off');
  assert.equal(pickSubtitle(tracks, null, undefined, 'fre'), 'fr1');
  assert.equal(pickSubtitle(tracks, undefined, undefined), undefined);
  assert.equal(pickSubtitle([], 'en1', { subId: 'en1' }, 'eng'), undefined);
});

test('persistCast: saves a position with the episode parsed from its id, not one below 5 s or without a video id', () => {
  const c = { req: { videoId: 'tt9001:2:3', title: 'Show S02E03', poster: 'http://example.com/p.jpg' }, duration: 1800, infoHash: 'b'.repeat(40), fileIdx: 1 };
  persistCast(c, 4);
  assert.equal(getProgress('tt9001:2:3'), undefined, 'a TV still at the start is no position');
  persistCast(c, 600);
  const p = getProgress('tt9001:2:3')!;
  assert.deepEqual([p.metaId, p.type, p.season, p.episode, p.pos, p.dur, p.name, p.poster, p.infoHash, p.fileIdx], ['tt9001', 'series', 2, 3, 600, 1800, 'Show S02E03', 'http://example.com/p.jpg', 'b'.repeat(40), 1]);
  persistCast({ ...c, duration: 0, req: { ...c.req, poster: undefined } }, 700);
  const q = getProgress('tt9001:2:3')!;
  assert.deepEqual([q.pos, q.dur, q.poster], [700, 1800, 'http://example.com/p.jpg'], 'no duration or poster: the saved ones');
  persistCast({ ...c, req: { title: 'x' } }, 600);
  persistCast({ ...c, req: { videoId: 'tt9002', title: 'Film' } }, 600);
  assert.equal(getProgress('tt9002')?.type, 'movie');
});
