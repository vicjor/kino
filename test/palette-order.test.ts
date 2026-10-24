import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byGroup } from '../client/lib/palette-order.ts';

const r = (id: string, group: string, score: number) => ({ id, group, score });

test('byGroup: each group once, the group with the best row first, rows by score within it', () => {
  const rows = [r('t1', 'Titles', 450), r('c1', 'Cast', 470), r('t2', 'Titles', 430), r('c2', 'Cast', 420), r('g1', 'Go to', 60), r('l1', 'Continue watching', 440)];
  assert.deepEqual(byGroup(rows).map((x) => x.id), ['c1', 'c2', 't1', 't2', 'l1', 'g1']);
});

test('byGroup: groups that tie on their best row go by name and do not interleave; the input is left as it was', () => {
  const rows = [r('t1', 'Titles', 400), r('c1', 'Cast', 400), r('t2', 'Titles', 300), r('c2', 'Cast', 350)];
  assert.deepEqual(byGroup(rows).map((x) => x.id), ['c1', 'c2', 't1', 't2']);
  assert.deepEqual(rows.map((x) => x.id), ['t1', 'c1', 't2', 'c2']);
  assert.deepEqual(byGroup([]), []);
});
