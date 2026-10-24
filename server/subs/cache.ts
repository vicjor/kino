import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SUBS_DIR } from '../config.js';
import { logger, errMsg } from '../log.js';
import { payloadOf } from './ids.js';

const log = logger('subs');
const DAY = 86_400_000;

/** Bump CACHE_V when convert() output changes, so a file cached by an older parser is fetched again. v2: hourless VTT cues. */
const CACHE_V = 2;
/** Keyed on the id without its tag, so a signed id finds what its unsigned (older) form cached. */
export function cachePath(id: string, dir = SUBS_DIR): string { return path.join(dir, crypto.createHash('sha1').update(`v${CACHE_V}:${payloadOf(id)}`).digest('hex') + '.vtt'); }

/** A cached subtitle, marked as used (mtime) so pruning keeps what is still being watched. */
export function readCached(file: string): string | undefined {
  let vtt: string;
  try { vtt = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* read-only is fine */ }
  return vtt || undefined;
}

/** Save a converted subtitle: a temp file renamed into place, so a crash or a concurrent read never sees half a file. */
export function writeCached(file: string, vtt: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, vtt); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw e; }
}

/** Cache files not used for maxAgeDays. Files from an older CACHE_V are never read again, so they age out too, as does a temp file a crash left behind. */
export function staleSubs(files: { name: string; mtimeMs: number }[], now: number, maxAgeDays = 60): string[] {
  const cutoff = now - maxAgeDays * DAY;
  return files.filter((f) => /\.(vtt|tmp)$/.test(f.name) && f.mtimeMs < cutoff).map((f) => f.name);
}

/** Delete what staleSubs picks from the subtitle cache. Returns how many files went. */
export async function pruneSubs(now = Date.now(), maxAgeDays = 60, dir = SUBS_DIR): Promise<number> {
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return 0; }
  const files: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try { const st = await fs.promises.stat(path.join(dir, name)); if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs }); } catch { /* gone */ }
  }
  let removed = 0;
  for (const name of staleSubs(files, now, maxAgeDays)) {
    try { await fs.promises.unlink(path.join(dir, name)); removed++; } catch { /* gone */ }
  }
  if (removed) log.info('pruned unused subtitles', { removed, kept: files.length - removed });
  return removed;
}

/** Prune at most once a day, on use: the first subtitle after a start, then daily while subtitles are in use. */
let lastPrune = 0;
export function maybePrune(now = Date.now()): void {
  if (now - lastPrune < DAY) return;
  lastPrune = now;
  setTimeout(() => { pruneSubs(now).catch((e) => log.warn('subtitle prune failed', { err: errMsg(e) })); }, 0).unref();
}
