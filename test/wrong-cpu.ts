import fs from 'node:fs';
import path from 'node:path';

/** Writes a Mach-O header for a CPU that does not exist. macOS refuses to spawn it with errno -86, as it does an Intel binary on Apple Silicon without Rosetta. */
export function wrongCpuBinary(dir: string, name = 'wrong-cpu'): string {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);   // 64-bit Mach-O magic
  b.writeUInt32LE(0x0100007f, 4);   // cputype: no such CPU
  b.writeUInt32LE(2, 12);           // MH_EXECUTE
  const p = path.join(dir, name);
  fs.writeFileSync(p, b, { mode: 0o755 });
  return p;
}

/** The -86 tests only mean something on macOS. */
export const notMac = process.platform !== 'darwin' && 'errno -86 is macOS only';
