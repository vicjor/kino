import type { TorrentFile } from 'webtorrent';

const CHUNK = 65536;

function sumChunk(buf: Buffer, acc: bigint): bigint {
  for (let i = 0; i + 8 <= buf.length; i += 8) acc = (acc + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
  return acc;
}

/** OpenSubtitles hash: size + sum of first and last 64 KiB as little-endian uint64s. */
export function hashFromChunks(size: number, head: Buffer, tail: Buffer): string {
  let h = BigInt(size);
  h = sumChunk(head, h);
  h = sumChunk(tail, h);
  return h.toString(16).padStart(16, '0');
}

async function readRange(f: TorrentFile, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of f.createReadStream({ start, end })) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function oshash(f: TorrentFile, timeoutMs = 25_000): Promise<string> {
  if (f.length < CHUNK * 2) throw new Error('file too small for oshash');
  const work = (async () => {
    const [head, tail] = await Promise.all([readRange(f, 0, CHUNK - 1), readRange(f, f.length - CHUNK, f.length - 1)]);
    return hashFromChunks(f.length, head, tail);
  })();
  return Promise.race([work, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('oshash timeout')), timeoutMs))]);
}
