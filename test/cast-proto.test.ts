import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * castv2 0.1.10 asks for protobufjs ^6, and package.json overrides it to 7.x. castv2 encodes and decodes every Cast
 * message through its own lib/proto.js (protobuf.load, lookupType, encode, decode), so these run that module as is.
 */
type Codec = { serialize(m: object): Uint8Array; parse(b: Uint8Array): Record<string, unknown> };
// castv2 is castv2-client's dependency, so resolve it from there, as the server gets it.
const fromClient = createRequire(createRequire(import.meta.url).resolve('castv2-client'));
const { CastMessage } = fromClient('castv2/lib/proto.js') as { CastMessage: Codec };

// proto.js loads cast_channel.proto asynchronously and throws 'extension not loaded yet' until it has.
before(async () => {
  for (let i = 0; i < 200; i++) {
    try { CastMessage.parse(new Uint8Array()); return; } catch (e) { if (!/not loaded yet/.test((e as Error).message)) return; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('cast_channel.proto never loaded');
});

const NS = 'urn:x-cast:com.google.cast.tp.heartbeat';
/** One length-delimited field, written by hand: key byte, length byte, bytes (every value here is under 128 bytes). */
const field = (key: number, value: string | Uint8Array) => {
  const b = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([Buffer.from([key, b.length]), b]);
};
/** A heartbeat PING from sender-0 to receiver-0 in wire format: fields 1 to 6, varint 0 for both enums. */
const PING = Buffer.concat([
  Buffer.from([0x08, 0x00]), field(0x12, 'sender-0'), field(0x1a, 'receiver-0'), field(0x22, NS),
  Buffer.from([0x28, 0x00]), field(0x32, '{"type":"PING"}'),
]);
const base = { protocolVersion: 0, sourceId: 'sender-0', destinationId: 'receiver-0', namespace: NS };

test('a string payload encodes to the known bytes and decodes back', () => {
  const msg = { ...base, payloadType: 0, payloadUtf8: '{"type":"PING"}' };
  const bytes = CastMessage.serialize(msg);
  assert.deepEqual(Buffer.from(bytes), PING);
  const back = CastMessage.parse(bytes);
  assert.deepEqual({ ...back }, msg);
});

test('a message encoded elsewhere decodes', () => {
  const m = CastMessage.parse(PING);
  assert.equal(m.protocolVersion, 0);
  assert.equal(m.sourceId, 'sender-0');
  assert.equal(m.destinationId, 'receiver-0');
  assert.equal(m.namespace, NS);
  assert.equal(m.payloadType, 0);
  assert.equal(m.payloadUtf8, '{"type":"PING"}');
});

test('a binary payload round-trips byte for byte', () => {
  const data = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x0a]);
  const msg = { ...base, namespace: 'urn:x-cast:com.example.binary', payloadType: 1, payloadBinary: data };
  const bytes = CastMessage.serialize(msg);
  assert.deepEqual(Buffer.from(bytes).subarray(-8), field(0x3a, data), 'field 7, length 6, the bytes');
  const back = CastMessage.parse(bytes);
  assert.equal(back.payloadType, 1);
  assert.deepEqual(Buffer.from(back.payloadBinary as Uint8Array), data);
  assert.equal(Object.hasOwn(back, 'payloadUtf8'), false, 'no string payload on the wire');
});

test('a message missing a required field is refused', () => {
  assert.throws(() => CastMessage.parse(Buffer.from([0x08, 0x00])), /missing required/);
});
