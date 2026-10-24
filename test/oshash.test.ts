import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashFromChunks } from '../server/subs/oshash.ts';

test('oshash of a synthetic file matches reference implementation', () => {
  // reference: size + sum(uint64le over first 64K) + sum(uint64le over last 64K), mod 2^64
  const size = 200_000;
  const head = Buffer.alloc(65536); const tail = Buffer.alloc(65536);
  for (let i = 0; i < 65536; i++) { head[i] = (i * 7) & 0xff; tail[i] = (i * 13 + 5) & 0xff; }
  let ref = BigInt(size);
  for (let i = 0; i < 65536; i += 8) ref = (ref + head.readBigUInt64LE(i) + tail.readBigUInt64LE(i)) & 0xffffffffffffffffn;
  assert.equal(hashFromChunks(size, head, tail), ref.toString(16).padStart(16, '0'));
  assert.equal(hashFromChunks(size, head, tail).length, 16);
});

test('zero file', () => {
  const z = Buffer.alloc(65536);
  assert.equal(hashFromChunks(131072, z, z), '0000000000020000');
});
