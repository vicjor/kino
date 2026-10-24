import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, HLS_DIR } from './config.js';
import { getState } from './store.js';
import type { ErrorCode } from './types.js';

export function freeBytes(dir = CACHE_DIR): { free: number; total: number } {
  const s = fs.statfsSync(dir);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return total;
}

/** Run `fn` with at most `n` of them in flight; the rest wait their turn in order. */
function limiter(n: number) {
  let busy = 0; const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy < n) busy++; else await new Promise<void>((r) => waiting.push(r));   // a woken caller takes the slot of the one that woke it
    try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else busy--; }
  };
}

/** dirSize off the request thread: fs.promises, at most `limit` readdirs and stats in flight. Missing or vanished entries count 0. */
export async function dirSizeAsync(dir: string, limit = 16): Promise<number> {
  const run = limiter(limit);
  const walk = async (d: string): Promise<number> => {
    let ents: fs.Dirent[];
    try { ents = await run(() => fs.promises.readdir(d, { withFileTypes: true })); } catch { return 0; }
    const sizes = await Promise.all(ents.map((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : run(() => fs.promises.stat(p)).then((st) => st.size, () => 0);
    }));
    return sizes.reduce((a, n) => a + n, 0);
  };
  return walk(dir);
}

/** How long one HLS folder total is reused: every Settings visit and cache clear asks, and a 2 h transcode is thousands of segment files. */
export const HLS_BYTES_MS = 5_000;
let hlsWalk: { bytes: Promise<number>; done?: number } | undefined;
/** Bytes under the HLS folder. One walk at a time; its total is reused for HLS_BYTES_MS after it ends. */
export function hlsBytes(now = Date.now()): Promise<number> {
  if (hlsWalk && (hlsWalk.done === undefined || now - hlsWalk.done < HLS_BYTES_MS)) return hlsWalk.bytes;
  const walk: { bytes: Promise<number>; done?: number } = { bytes: dirSizeAsync(HLS_DIR) };
  void walk.bytes.finally(() => { walk.done = Date.now(); });
  return (hlsWalk = walk).bytes;
}

export class DiskFullError extends Error { status = 507; code: ErrorCode = 'disk-full'; }

/** What the player shows when the disk is nearly full. */
export function diskFullMessage(free: number, min: number): string {
  return `Disk nearly full: ${(free / 1024 ** 3).toFixed(1)} GB free, need ${(min / 1024 ** 3).toFixed(0)} GB. Clear the cache in Settings.`;
}

/** The disk under `dir` has less free than the setting asks to keep: by how much (`need` bytes). Undefined when it is fine or cannot be read. */
export function shortfall(dir = CACHE_DIR): { free: number; min: number; need: number } | undefined {
  let free: number;
  try { free = freeBytes(dir).free; } catch { return undefined; }
  const min = getState().settings.minFreeBytes;
  return free < min ? { free, min, need: min - free } : undefined;
}

/** Throw when the box is close to full. A full disk has killed other services on this Mac. */
export function guard(): void {
  const { free } = freeBytes();
  const min = getState().settings.minFreeBytes;
  if (free < min) throw new DiskFullError(diskFullMessage(free, min));
}
