import path from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import type { Request, Response, NextFunction } from 'express';
import { logger, errMsg } from './log.js';

const log = logger('lifecycle');

// ---------------------------------------------------------------- boot ----
/**
 * From `ps -axo pid=,ppid=,command=`: the ffmpeg processes launchd adopted (ppid 1) that write under hlsDir,
 * the transcoders of a Kino that died without its shutdown (kill -9, a crashed tsx watch or desktop app).
 * A live Kino's own ffmpegs have it as their parent, another install's write under another folder.
 */
export function orphanTranscoders(ps: string, hlsDir: string): number[] {
  const dir = hlsDir.endsWith(path.sep) ? hlsDir : hlsDir + path.sep;
  const out: number[] = [];
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m && m[2] === '1' && /(^|\/)ffmpeg\s/.test(m[3]) && m[3].includes(dir)) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Kill the orphaned transcoders before the HLS folder is wiped, or they keep a core busy and write into it.
 * SIGKILL, not SIGTERM: a parked session's ffmpeg is SIGSTOPped and would hold a TERM until it is continued.
 */
export function reapOrphanTranscoders(hlsDir: string): number {
  let n = 0;
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const pid of orphanTranscoders(ps, hlsDir)) { try { process.kill(pid, 'SIGKILL'); n++; } catch { /* already gone */ } }
  } catch (e) { log.debug('orphan sweep failed', { err: errMsg(e) }); }
  if (n) log.info('reaped orphaned ffmpeg', { n });
  return n;
}

// ------------------------------------------------------------ shutdown ----
/** True from the first step of the shutdown on. */
let stopping = false;

const children = new Set<ChildProcess>();
/**
 * A helper process the shutdown kills (subtitle extraction, subtitle sync): SIGKILL in its sequence, or at once
 * when it starts after that. HLS transcoders have their own stop (hls.stopAll). Returns p.
 */
export function killOnShutdown<T extends ChildProcess>(p: T): T {
  if (stopping) { p.kill('SIGKILL'); return p; }
  if (p.exitCode !== null || p.signalCode !== null) return p;
  children.add(p);
  const gone = () => children.delete(p);
  p.once('exit', gone).once('close', gone);   // a binary that cannot start emits 'error' and 'close', never 'exit'
  return p;
}
/**
 * While stopping, every request gets a 503 and its connection closes: a keep-alive connection must not start a
 * transcode or load a torrent after their stop step ran. Mounted first on the app.
 */
export function refuseWhileStopping(_req: Request, res: Response, next: NextFunction): void {
  if (!stopping) { next(); return; }
  res.setHeader('Connection', 'close');
  res.status(503).json({ error: 'Kino is stopping. Try again in a moment.' });
}

const stops = new Map<string, () => void>();
/**
 * A synchronous stop for a module that keeps its own timer (up next): the shutdown runs it right after its `now`
 * steps. One name holds one stop, so registering again replaces it. Once the shutdown began, fn runs at once.
 */
export function stopOnShutdown(name: string, fn: () => void): void {
  if (!stopping) { stops.set(name, fn); return; }
  try { fn(); } catch (e) { log.warn('shutdown step failed', { step: name, err: errMsg(e) }); }
}

/** SIGKILL every helper process still running. Returns how many were signalled. */
export function killChildren(): number {
  let n = 0;
  for (const p of children) { try { if (p.kill('SIGKILL')) n++; } catch { /* already gone */ } }
  children.clear();
  return n;
}

/** What a shutdown stops, in the order runShutdown runs it. */
export interface ShutdownSteps {
  /** State to disk, synchronously. First, so a step that hangs loses nothing, and last, for what the steps saved. */
  flush: () => void;
  /** Synchronous stops (transcoders, sessions, discovery), in order. One that throws is logged and the rest still run. */
  now: [name: string, fn: () => void][];
  /** Stop the TV. Bounded by castMs: a Chromecast that never answers must not hold the exit. */
  cast: () => Promise<unknown>;
  /** Close the torrent client. Gets what is left of totalMs. */
  torrent: () => Promise<unknown>;
  /** Drop every open connection: SSE streams, keep-alives, file streams. */
  closeHttp: () => void;
}

/** totalMs stays under the 5 s exit deadline of the signal handler, so the last flush always runs. */
export const SHUTDOWN_BUDGET = { castMs: 2000, totalMs: 4300 };

/** Run fn, waiting at most ms for it. Never throws: a failure or a timeout is logged and the shutdown goes on. */
export async function bounded(name: string, fn: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), Math.max(0, ms)); });
  try {
    if (await Promise.race([Promise.resolve().then(fn).then(() => 'done' as const), late]) === 'late') log.warn('shutdown step timed out', { step: name, ms });
  } catch (e) { log.warn('shutdown step failed', { step: name, err: errMsg(e) }); }
  finally { clearTimeout(timer); }
}

/** Stop everything without exiting: flush, synchronous stops (then the registered ones), helper processes, the TV, the torrents, connections, flush. Never throws. */
export async function runShutdown(s: ShutdownSteps, budget = SHUTDOWN_BUDGET): Promise<void> {
  const t0 = Date.now();
  stopping = true;
  const step = (name: string, fn: () => void) => { try { fn(); } catch (e) { log.warn('shutdown step failed', { step: name, err: errMsg(e) }); } };
  step('flush', s.flush);
  for (const [name, fn] of s.now) step(name, fn);
  for (const [name, fn] of stops) step(name, fn);
  stops.clear();
  step('children', () => { const n = killChildren(); if (n) log.info('killed helper processes', { n }); });
  await bounded('cast', s.cast, budget.castMs);
  await bounded('torrent', s.torrent, budget.totalMs - (Date.now() - t0));
  step('http', s.closeHttp);
  step('flush', s.flush);
}
