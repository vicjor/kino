import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { receiverState, RECEIVER_STATE_LABEL, type ReceiverState } from '../client/lib/receiver-state.ts';
import type { ReceiverInfo } from '../server/types.js';

const rx = (o: Partial<ReceiverInfo> = {}) => ({ online: true, ...o });
const media = (state: NonNullable<ReceiverInfo['media']>['state']) => ({ state, currentTime: 0 });
const app = { id: 'CC1AD845', name: 'Default Media Receiver' };

test('receiverState: power comes first, then reachability', () => {
  assert.equal(receiverState(rx({ waking: true, asleep: true, online: false })), 'waking');
  assert.equal(receiverState(rx({ asleep: true, online: false })), 'off');
  assert.equal(receiverState(rx({ online: false, app, media: media('PLAYING') })), 'offline', 'a stale media state on an unreachable device');
});

test('receiverState: what the media is doing, then whether an app is open', () => {
  assert.equal(receiverState(rx({ app, media: media('PLAYING') })), 'playing');
  assert.equal(receiverState(rx({ app, media: media('PAUSED') })), 'paused');
  assert.equal(receiverState(rx({ app, media: media('BUFFERING') })), 'loading');
  assert.equal(receiverState(rx({ app, media: media('IDLE') })), 'active');
  assert.equal(receiverState(rx({ app })), 'active');
  assert.equal(receiverState(rx()), 'idle');
});

test('RECEIVER_STATE_LABEL: every state has words, and every state is one class token', () => {
  for (const [state, label] of Object.entries(RECEIVER_STATE_LABEL)) {
    assert.match(state, /^[a-z]+$/, `${state} is usable as a class name`);
    assert.ok(label.length > 0);
  }
  assert.equal(RECEIVER_STATE_LABEL.waking, 'Turning on', 'two words of copy, one class');
});

test('castcenter.css styles only states that exist', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'client', 'styles', 'castcenter.css'), 'utf8');
  const styled = [...css.matchAll(/\.cc-state\.([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(styled.length > 0);
  for (const s of styled) assert.ok(s in RECEIVER_STATE_LABEL, `.cc-state.${s} is not a ReceiverState`);
  const states: ReceiverState[] = ['playing', 'paused', 'active', 'loading', 'offline'];
  for (const s of states) assert.ok(styled.includes(s), `.cc-state.${s} keeps its dot color`);
});
