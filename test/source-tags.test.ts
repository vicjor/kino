import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTags, castFit } from '../client/components/source-tags.ts';
import type { Source, StreamsResponse } from '../server/types.ts';

const mk = (o: Partial<Source>): Source => ({ id: o.id || 'x', infoHash: 'h', addon: 'T', releaseName: 'r', score: 50, warnings: [], seeders: 100, resolution: '1080p', codec: 'h264', ...o });

test('sourceTags marks best pick, the most headroom as reliable, and first healthy 4K', () => {
  const GB = 1024 ** 3;
  const data: StreamsResponse = { auto: 'b', addonsQueried: ['T'], addonsFailed: [], sources: [
    mk({ id: 'a', provider: 'ProviderA', seeders: 60, sizeBytes: 3 * GB, headroom: 2.4 }), mk({ id: 'b', provider: 'ProviderB', seeders: 90, sizeBytes: 0.9 * GB, headroom: 9.5 }), mk({ id: 'c', provider: 'ProviderB', seeders: 17, sizeBytes: 3.9 * GB, headroom: 0.4 }),
    mk({ id: 'd', resolution: '2160p', score: -5 }), mk({ id: 'e', resolution: '2160p' }),
  ] };
  const t = sourceTags(data);
  assert.deepEqual(t.get('b'), ['Best pick', 'Most reliable']);
  assert.equal(t.get('c'), undefined);
  assert.equal(t.get('d'), undefined);
  assert.deepEqual(t.get('e'), ['Best 4K']);
});

test('Most reliable follows the server\'s headroom, never a guessed count, a handful of seeders or a low resolution', () => {
  const tagged = (sources: Source[]) => [...sourceTags({ addonsQueried: [], addonsFailed: [], sources }).entries()].filter(([, t]) => t.includes('Most reliable')).map(([id]) => id);
  assert.deepEqual(tagged([mk({ id: 'many', seeders: 900, headroom: 3 }), mk({ id: 'room', seeders: 40, headroom: 12 })]), ['room']);
  assert.deepEqual(tagged([mk({ id: 'guess', seeders: 100, seedersEstimated: true, headroom: 50 }), mk({ id: 'few', seeders: 5, headroom: 40 }), mk({ id: 'sd', resolution: '480p', headroom: 30 }), mk({ id: 'ok', headroom: 2 })]), ['ok']);
  assert.deepEqual(tagged([mk({ id: 'old', headroom: undefined }), mk({ id: 'bad', score: -3, headroom: 9 })]), [], 'no headroom known, or not worth playing');
});

test('castFit: the Chromecast wants H.264, the LG TV decodes almost anything itself', () => {
  assert.equal(castFit(mk({}), 'cast').ok, 'yes');
  assert.equal(castFit(mk({ codec: 'hevc' }), 'cast').ok, 'meh');
  assert.equal(castFit(mk({ codec: 'hevc', resolution: '2160p' }), 'cast').ok, 'no');
  assert.equal(castFit(mk({ hdr: 'HDR10' }), 'cast').text, 'transcodes');
  assert.equal(castFit(mk({ codec: 'other' }), 'cast').ok, 'meh');
  assert.equal(castFit(mk({ codec: 'hevc', resolution: '2160p', hdr: 'DV' }), 'dlna').ok, 'yes');
  assert.equal(castFit(mk({ codec: 'av1' }), 'dlna').ok, 'meh');
  assert.equal(castFit(mk({ audio: 'DTS-HD' }), 'dlna').text, 'DTS may be silent');
  assert.equal(castFit(mk({ audio: 'DDP5.1' }), 'dlna').ok, 'yes');
});

test('castFit: the reasons are plain words, not "transcoded" or "tone-mapped"', () => {
  assert.equal(castFit(mk({ codec: 'hevc', hdr: 'HDR10' }), 'cast').why, 'The Mac converts the HEVC video and the HDR picture before it reaches the TV.');
  assert.equal(castFit(mk({ hdr: 'HDR10' }), 'cast').why, 'The Mac converts the HDR picture before it reaches the TV.');
  for (const s of [mk({ codec: 'hevc', resolution: '2160p' }), mk({ codec: 'av1' }), mk({ hdr: 'DV' })]) assert.doesNotMatch(castFit(s, 'cast').why ?? '', /transcod|tone.?map/i);
});
