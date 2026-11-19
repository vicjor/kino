import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSource } from '../server/next-source.ts';
import type { Source } from '../server/types.ts';

const src = (id: string, o: Partial<Source> = {}) => ({ id, infoHash: id.split(':')[0], addon: 'a', releaseName: id, score: 50, warnings: [], ...o }) as Source;

test('nextSource: the same pack first, then the binge group, then the automatic pick', () => {
  const list = [src('auto:0'), src('grp:0', { bingeGroup: 'g' }), src('pack:3'), src('other:0')];
  assert.equal(nextSource(list, 'auto:0', { infoHash: 'pack', bingeGroup: 'g' })?.id, 'pack:3');
  assert.equal(nextSource(list, 'auto:0', { infoHash: 'gone', bingeGroup: 'g' })?.id, 'grp:0');
  assert.equal(nextSource(list, 'auto:0', { bingeGroup: 'other' })?.id, 'auto:0');
  assert.equal(nextSource(list, 'auto:0', { bingeGroup: null })?.id, 'auto:0');
  assert.equal(nextSource(list, 'auto:0')?.id, 'auto:0');
});

test('nextSource: a pack or group not worth playing is not followed; no pick, no source', () => {
  const list = [src('auto:0'), src('grp:0', { bingeGroup: 'g', score: 0 }), src('pack:3', { score: -40 })];
  assert.equal(nextSource(list, 'auto:0', { infoHash: 'pack', bingeGroup: 'g' })?.id, 'auto:0');
  assert.equal(nextSource(list, undefined, { infoHash: 'pack', bingeGroup: 'g' }), undefined, 'never the first row by default');
  assert.equal(nextSource([], 'auto:0'), undefined);
});
