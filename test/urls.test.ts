import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleUrl, playUrl, readPlayParams, type PlayParams } from '../client/lib/urls.ts';

const query = (url: string) => new URLSearchParams(url.split('?')[1] || '');

test('titleUrl: plain, and with an encoded episode id', () => {
  assert.equal(titleUrl('movie', 'tt1'), '/title/movie/tt1');
  assert.equal(titleUrl('series', 'tt2', 'tt2:1:3'), '/title/series/tt2?v=tt2%3A1%3A3');
});

test('playUrl round trip keeps a magnet flag, a start at 0 and file 0', () => {
  const p: PlayParams = { type: 'movie', videoId: 'magnet:abc:0', metaId: 'magnet:abc', infoHash: 'abc', fileIdx: 0, name: 'A & B = C?', magnet: true, t: 0 };
  const url = playUrl(p);
  assert.ok(url.startsWith('/play?'));
  assert.equal(query(url).get('t'), '0', 't=0 means start over, so it must not be dropped');
  assert.deepEqual(readPlayParams(query(url)), { ...p, poster: undefined, background: undefined, season: undefined, episode: undefined });
});

test('playUrl round trip for an episode, and without t it stays unset so the player looks up the resume point', () => {
  const p: PlayParams = { type: 'series', videoId: 'tt9:2:5', metaId: 'tt9', infoHash: 'f00', fileIdx: 3, name: 'Show S2 E5', poster: 'https://x/p.jpg?a=1&b=2', background: 'https://x/b.jpg', season: 2, episode: 5, t: 754.5 };
  const back = readPlayParams(query(playUrl(p)));
  assert.deepEqual(back, { ...p, magnet: false });
  const noT = readPlayParams(query(playUrl({ ...p, t: undefined })));
  assert.equal(noT.t, undefined);
  assert.equal(noT.magnet, false);
});

test('playUrl drops empty values and readPlayParams fills defaults', () => {
  const url = playUrl({ type: 'movie', videoId: 'tt1', metaId: 'tt1', infoHash: 'h', name: '', poster: '', fileIdx: undefined });
  assert.equal(query(url).has('name'), false);
  assert.equal(query(url).has('poster'), false);
  assert.equal(query(url).has('fileIdx'), false);
  const back = readPlayParams(query(url));
  assert.equal(back.name, '');
  assert.equal(back.poster, undefined);
  assert.equal(back.fileIdx, undefined);
  assert.equal(readPlayParams(new URLSearchParams()).type, 'movie');
});

test('playUrl round trip keeps the TV mode, and a link without it has no tv key at all', () => {
  const p: PlayParams = { type: 'series', videoId: 'tt9:2:5', metaId: 'tt9', infoHash: 'f00', fileIdx: 3, name: 'Show S2 E5', tv: true };
  assert.equal(readPlayParams(query(playUrl(p))).tv, true);
  assert.equal('tv' in readPlayParams(query(playUrl({ ...p, tv: undefined }))), false);
  assert.equal(query(playUrl({ ...p, magnet: false, tv: false })).toString().includes('false'), false, 'an off flag stays out of the link');
});
