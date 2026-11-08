import { spawn, type ChildProcess } from 'node:child_process';
import { logger, errMsg } from './log.js';
import { KEEP_AWAKE } from './config.js';

const log = logger('awake');

/**
 * A Mac idle-sleeps while Kino serves a TV: on battery once its own screen goes dark, mid-film or paused. The TV, the
 * Chromecast and the phone then reach nothing, and a resume fails as if the source were dead. So Kino holds an idle-sleep
 * assertion (`caffeinate -i`, battery too) while someone watches and for this long after, so a film paused for a while
 * still finds Kino. Closing the lid still sleeps the Mac: nothing a user process may do stops that.
 */
export const AWAKE_GRACE_MS = 60 * 60_000;
/** How often the busy state is read. */
const AWAKE_TICK_MS = 30_000;

/** Hold the Mac awake now? Someone is watching, or was within the grace period (`lastBusyAt` 0: never since start). */
export function wantAwake(busy: boolean, lastBusyAt: number, now: number, graceMs = AWAKE_GRACE_MS): boolean {
  return busy || (lastBusyAt > 0 && now - lastBusyAt < graceMs);
}

/** `KINO_KEEP_AWAKE=off` (or 0, false, no) turns it off. On by default, macOS only. */
export const keepAwakeOn = (env: string | undefined, platform: string): boolean => platform === 'darwin' && !/^(off|0|false|no)$/i.test((env || '').trim());

let child: ChildProcess | null = null;
let lastBusyAt = 0;
let timer: NodeJS.Timeout | null = null;

function hold(): void {
  // -w: caffeinate exits with this process, so a crash or SIGKILL never leaves the Mac held awake.
  const c = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  child = c;
  c.on('error', (e) => { log.warn('caffeinate did not start', { err: errMsg(e) }); if (child === c) child = null; });
  c.on('exit', () => { if (child === c) child = null; });
  log.info('keeping the Mac awake');
}
function release(): void {
  if (!child) return;
  child.kill();
  child = null;
  log.info('the Mac may sleep again');
}

function tick(busy: boolean): void {
  const now = Date.now();
  if (busy) lastBusyAt = now;
  const want = wantAwake(busy, lastBusyAt, now);
  if (want && !child) hold();
  else if (!want && child) release();
}

/** Start following `isBusy` (the same flag /health reports). Does nothing off macOS or with KINO_KEEP_AWAKE=off. */
export function start(isBusy: () => boolean): void {
  if (timer || !keepAwakeOn(KEEP_AWAKE, process.platform)) return;
  timer = setInterval(() => tick(isBusy()), AWAKE_TICK_MS);
  timer.unref();
  tick(isBusy());
}

/** Let the Mac sleep again and stop following (shutdown). */
export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  release();
}
