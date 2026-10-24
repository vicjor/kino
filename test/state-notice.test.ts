import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileName, repairedText, repairedTitle } from '../client/lib/state-notice.ts';

const R = (o: Partial<Parameters<typeof repairedText>[0]> = {}) => ({ repairedFields: 0, droppedProgress: 0, prunedProgress: 0, prunedCastDevices: 0, at: 1, ...o });

test('repairedText: a repair, then what was cleared, then where the copy is, counted in words', () => {
  assert.equal(repairedText(R({ repairedFields: 2, droppedProgress: 1, prunedProgress: 3, prunedCastDevices: 1, backup: '/Users/x/kino-data/state.json.bak' })),
    'Kino fixed 2 damaged parts of its saved data and left out 1 watch position it could not read. It also cleared 3 titles you opened for only a few seconds over a month ago and the play history of 1 TV or speaker not used for three months. The file from before is kept as state.json.bak.');
  assert.equal(repairedText(R({ repairedFields: 1 })), 'Kino fixed 1 damaged part of its saved data.');
  assert.equal(repairedText(R({ prunedProgress: 1, backup: 'C:\\kino\\state.json.bak' })), 'Kino cleared 1 title you opened for only a few seconds over a month ago. The file from before is kept as state.json.bak.');
  assert.equal(repairedText(R({ prunedCastDevices: 2 })), 'Kino cleared the play history of 2 TVs or speakers not used for three months.');
});

test('repairedTitle: a repair says so, pruning alone is clearing', () => {
  assert.equal(repairedTitle(R({ repairedFields: 1 })), 'Saved data was repaired');
  assert.equal(repairedTitle(R({ droppedProgress: 1 })), 'Saved data was repaired');
  assert.equal(repairedTitle(R({ prunedProgress: 4, prunedCastDevices: 1 })), 'Old entries were cleared');
});

test('notice copy: no em or en dashes, file names from either kind of path', () => {
  assert.doesNotMatch(repairedText(R({ repairedFields: 1, droppedProgress: 2, prunedProgress: 3, prunedCastDevices: 4, backup: 'a/b' })), /[\u2013\u2014]/);
  assert.equal(fileName('/a/b/state.json.corrupt-1'), 'state.json.corrupt-1');
  assert.equal(fileName('C:\\a\\state.json.bak'), 'state.json.bak');
  assert.equal(fileName('plain'), 'plain');
});
