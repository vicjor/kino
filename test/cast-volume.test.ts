import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvVolume, stepVolume, withVolume, volumeUnknown } from '../client/lib/cast-volume.ts';
import type { ReceiverInfo } from '../server/types.js';

const rx = (id: string, volume: number, muted = false) => ({ id, name: id, model: 'Chromecast', audioOnly: false, online: true, volume, muted }) as unknown as ReceiverInfo;

test('tvVolume: the receiver entry wins over the stream volume in the cast status', () => {
  const cast = { deviceId: 'living', volume: 1, muted: false };
  assert.deepEqual(tvVolume(cast, [rx('kitchen', 0.8), rx('living', 0.3, true)]), { level: 0.3, muted: true, receiverId: 'living' });
});

test('tvVolume: falls back to the cast status without a receiver entry', () => {
  assert.deepEqual(tvVolume({ deviceId: 'living', volume: 0.4, muted: true }, [rx('kitchen', 0.8)]), { level: 0.4, muted: true });
  assert.deepEqual(tvVolume({ deviceId: 'living' }, null), { level: 1, muted: false });
  assert.deepEqual(tvVolume({ volume: 0.5 }, [rx('living', 0.3)]), { level: 0.5, muted: false }, 'no device id, no match');
});

test('stepVolume: one step from a 30 % TV is 25 % or 35 %, never a jump from 100 %', () => {
  assert.equal(stepVolume(0.3, -0.05), 0.25);
  assert.equal(stepVolume(0.3, 0.05), 0.35);
  assert.equal(stepVolume(0.02, -0.05), 0);
  assert.equal(stepVolume(0.98, 0.05), 1);
  assert.equal(stepVolume(0.33, 0.05), 0.4, 'snaps to 5 %');
});

test('withVolume: changes only the named device and keeps what the change leaves out', () => {
  const list = [rx('living', 0.3, true), rx('kitchen', 0.8)];
  const out = withVolume(list, 'living', { muted: false })!;
  assert.equal(out[0].volume, 0.3); assert.equal(out[0].muted, false);
  assert.equal(out[1], list[1]);
  assert.equal(withVolume(list, 'living', { level: 0.5 })![0].volume, 0.5);
  assert.equal(withVolume(null, 'living', { level: 0.5 }), null);
});

test('volumeUnknown: a DLNA TV at 0 and not muted is not telling, a muted one or a Chromecast at 0 is', () => {
  const dlna = (volume: number, muted = false) => ({ ...rx('lg', volume, muted), kind: 'dlna' as const });
  assert.equal(volumeUnknown(dlna(0)), true);
  assert.equal(volumeUnknown(dlna(0, true)), false);
  assert.equal(volumeUnknown(dlna(0.3)), false);
  assert.equal(volumeUnknown(rx('living', 0)), false);
  assert.deepEqual(tvVolume({ deviceId: 'lg' }, [dlna(0)]), { level: 0, muted: false, receiverId: 'lg', unknown: true });
});
