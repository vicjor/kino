import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlineTvs, singleTv, tvsOnly } from '../client/lib/tvs.ts';
import type { ReceiverInfo } from '../server/types.js';

const rx = (id: string, o: Partial<ReceiverInfo> = {}) => ({ id, name: id, model: 'Chromecast', audioOnly: false, online: true, volume: 1, muted: false, kino: false, updatedAt: 0, ...o }) as ReceiverInfo;

test('onlineTvs: speakers and offline devices are not TVs', () => {
  const list = [rx('living'), rx('kitchen', { audioOnly: true }), rx('bedroom', { online: false }), rx('lg', { kind: 'dlna' })];
  assert.deepEqual(onlineTvs(list).map((r) => r.id), ['living', 'lg']);
  assert.deepEqual(onlineTvs(null), []);
  assert.deepEqual(onlineTvs(undefined), []);
});

test('singleTv: exactly one TV online goes straight there', () => {
  const list = [rx('kitchen', { audioOnly: true }), rx('living'), rx('bedroom', { online: false })];
  assert.equal(singleTv(list), list[1]);
});

test('singleTv: none or several online means the picker', () => {
  assert.equal(singleTv(null), null);
  assert.equal(singleTv([]), null);
  assert.equal(singleTv([rx('kitchen', { audioOnly: true })]), null, 'a speaker alone is not a TV');
  assert.equal(singleTv([rx('living', { online: false })]), null);
  assert.equal(singleTv([rx('living'), rx('lg', { kind: 'dlna' })]), null);
});

test('singleTv: the same entry on every call, so a store selector does not re-render forever', () => {
  const list = [rx('living'), rx('kitchen', { audioOnly: true })];
  assert.equal(singleTv(list), singleTv(list));
  assert.equal(singleTv(list), list[0]);
});

test('tvsOnly: the Cast controls drop speakers, keep offline TVs', () => {
  const list = [rx('living'), rx('kitchen', { audioOnly: true }), rx('bedroom', { online: false })];
  assert.deepEqual(tvsOnly(list).map((r) => r.id), ['living', 'bedroom']);
  assert.deepEqual(tvsOnly(null), []);
});
