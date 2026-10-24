import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encodeFrame, decodeFrames, registration, isLg, ssap, io } from '../server/cast/lg.ts';

const serverFrame = (o: object) => { const d = Buffer.from(JSON.stringify(o)); return Buffer.concat([Buffer.from([0x81, d.length]), d]); };

test('frames: a masked client frame reads back, in all three length sizes', () => {
  for (const n of [5, 300, 70_000]) {
    const text = 'x'.repeat(n);
    const { frames, rest } = decodeFrames(encodeFrame(text));
    assert.equal(frames.length, 1); assert.equal(frames[0].opcode, 1); assert.equal(frames[0].data.toString(), text); assert.equal(rest.length, 0);
  }
});

test('frames: a partial frame waits for the rest, two whole ones both come out', () => {
  const two = Buffer.concat([serverFrame({ a: 1 }), serverFrame({ b: 2 })]);
  assert.equal(decodeFrames(two).frames.length, 2);
  const cut = two.subarray(0, two.length - 3);
  const { frames, rest } = decodeFrames(cut);
  assert.equal(frames.length, 1);
  assert.equal(rest.length, two.length - 3 - serverFrame({ a: 1 }).length);
});

test('registration: asks on the TV without a key, sends the key once there is one', () => {
  const first = registration() as { payload: Record<string, unknown> };
  assert.equal(first.payload.pairingType, 'PROMPT');
  assert.equal('client-key' in first.payload, false);
  assert.equal((registration('k1') as { payload: Record<string, unknown> }).payload['client-key'], 'k1');
});

test('isLg: by name or model', () => {
  assert.equal(isLg({ name: '[LG] TV', model: 'LG TV' }), true);
  assert.equal(isLg({ name: 'Living room TV', model: 'Chromecast' }), false);
});

/** A TV that upgrades, registers (handing out key "k1") and answers the request; `asked` collects what Kino sent. */
function fakeTv(asked: Record<string, unknown>[]) {
  return () => {
    const s = new EventEmitter() as EventEmitter & { write: (b: Buffer | string) => boolean; destroy: () => void };
    s.write = (b) => {
      if (typeof b === 'string') { setImmediate(() => s.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'))); return true; }
      for (const f of decodeFrames(b).frames) {
        if (f.opcode !== 1) continue;
        const m = JSON.parse(f.data.toString()) as { type: string; id: string; uri?: string };
        asked.push(m);
        if (m.type === 'register') setImmediate(() => s.emit('data', serverFrame({ type: 'registered', id: m.id, payload: { 'client-key': 'k1' } })));
        else setImmediate(() => s.emit('data', serverFrame({ type: 'response', id: m.id, payload: { returnValue: true } })));
      }
      return true;
    };
    s.destroy = () => undefined;
    setImmediate(() => s.emit('secureConnect'));
    return s as unknown as ReturnType<typeof io.connect>;
  };
}

test('ssap: registers, keeps the key for next time, sends the request', async () => {
  const real = io.connect;
  try {
    const asked: Record<string, unknown>[] = [];
    io.connect = fakeTv(asked);
    assert.deepEqual(await ssap('10.0.0.9', 'dlna:tv1', 'ssap://system/turnOff'), { returnValue: true });
    assert.equal(asked[1].uri, 'ssap://system/turnOff');
    const again: Record<string, unknown>[] = [];
    io.connect = fakeTv(again);
    await ssap('10.0.0.9', 'dlna:tv1', 'ssap://system/turnOff');
    assert.equal((again[0].payload as Record<string, unknown>)['client-key'], 'k1', 'no second prompt on the TV');
  } finally { io.connect = real; }
});
