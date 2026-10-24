import { test } from 'node:test';
import assert from 'node:assert/strict';
const { av1Playable, decodeQuery } = await import('../client/lib/player-caps.ts');

test('av1Playable: AV1 in MP4 or WebM counts, other codecs do not', () => {
  const asked: string[] = [];
  assert.equal(av1Playable((m) => { asked.push(m); return false; }), false);
  assert.deepEqual(asked, ['video/mp4; codecs="av01.0.08M.10"', 'video/webm; codecs="av01.0.08M.10"']);
  assert.equal(av1Playable((m) => m.startsWith('video/webm') && m.includes('av01')), true, 'WebM only (Matroska in Chromium)');
  assert.equal(av1Playable((m) => m.startsWith('video/mp4') && m.includes('av01')), true, 'MP4 only');
  assert.equal(av1Playable((m) => m.includes('hvc1')), false);
});

test('decodeQuery: the codecs a browser decodes, as the streams route reads them', () => {
  assert.equal(decodeQuery({ hevc: true, av1: true }), '&hevc=1&av1=1');
  assert.equal(decodeQuery({ hevc: true, av1: false }), '&hevc=1');
  assert.equal(decodeQuery({ av1: true }), '&av1=1');
  assert.equal(decodeQuery({ hevc: false, av1: false }), '');
});
