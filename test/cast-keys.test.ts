import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castKeyAction } from '../client/lib/cast-keys.ts';

// client/lib/cast-keys.ts: the TV's keys, shared by the Cast Center's controller and CastHotkeys.

const at = (key: string, shiftKey = false) => castKeyAction({ key, shiftKey });

test('castKeyAction: Space and K play or pause, either case', () => {
  for (const k of [' ', 'k', 'K']) assert.deepEqual(at(k), { do: 'play-pause' }, k);
});

test('castKeyAction: arrows skip 10 seconds, a minute with Shift, J and L skip 10', () => {
  assert.deepEqual(at('ArrowLeft'), { do: 'skip', by: -10, key: '←' });
  assert.deepEqual(at('ArrowRight'), { do: 'skip', by: 10, key: '→' });
  assert.deepEqual(at('ArrowLeft', true), { do: 'skip', by: -60, key: '⇧ ←' });
  assert.deepEqual(at('ArrowRight', true), { do: 'skip', by: 60, key: '⇧ →' });
  assert.deepEqual(at('j'), { do: 'skip', by: -10, key: 'J' });
  assert.deepEqual(at('L'), { do: 'skip', by: 10, key: 'L' });
});

test('castKeyAction: digits jump to tenths of the film, 0 to the start', () => {
  for (let n = 0; n <= 9; n++) assert.deepEqual(at(String(n)), { do: 'jump', tenth: n });
});

test('castKeyAction: up and down step the volume by 5%', () => {
  assert.deepEqual(at('ArrowUp'), { do: 'volume', by: 0.05, key: '↑' });
  assert.deepEqual(at('ArrowDown'), { do: 'volume', by: -0.05, key: '↓' });
});

test('castKeyAction: letters, lower or upper case', () => {
  const want = { m: 'mute', n: 'next', v: 'subs', e: 'stop-after', i: 'intro', s: 'source', h: 'here', x: 'stop' } as const;
  for (const [k, what] of Object.entries(want)) {
    assert.deepEqual(at(k), { do: what }, k);
    assert.deepEqual(at(k.toUpperCase()), { do: what }, k.toUpperCase());
  }
  assert.deepEqual(at('?'), { do: 'keys' });
});

test('castKeyAction: anything else is not a TV key', () => {
  for (const k of ['a', 'f', 'g', 'Escape', 'Enter', 'Tab', 'Shift', 'F1', '/', '-']) assert.equal(at(k), null, k);
});
