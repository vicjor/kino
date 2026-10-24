import { execFile, execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { unasar, binOverride } from '../config.js';
import { logger, errMsg } from '../log.js';

// The npm packages ship one binary per platform, and a wrong one (ffprobe-static's darwin/arm64 is
// an x86_64 build) only runs under Rosetta. So pick the first binary that actually runs, and look
// again (at most once a minute, in the background) while nothing runs or the pick failed to start,
// so a later `brew install ffmpeg` needs no restart.

const log = logger('bins');
export type BinName = 'ffmpeg' | 'ffprobe';
export type BinFrom = 'env' | 'static' | 'homebrew' | 'usr-local' | 'macports' | 'PATH';
export interface Candidate { path: string; from: BinFrom }
export interface Picked extends Candidate { ok: boolean; why?: string }
/** true when the binary runs; false, or the reason in words, when it does not. */
export type CanRun = (path: string) => boolean | string;

const ENV: Record<BinName, string> = { ffmpeg: 'FFMPEG_BIN', ffprobe: 'FFPROBE_BIN' };
const BUNDLED: Record<BinName, string | null | undefined> = { ffmpeg: ffmpegStatic, ffprobe: ffprobeStatic?.path };
const bundled = (name: BinName): string => { const p = BUNDLED[name]; return p ? unasar(p) : name; };

/** Where to look, best first: the override, the npm package's binary, Homebrew (Apple Silicon, then Intel), MacPorts, then PATH. By full path, since an app opened from Finder gets no shell PATH. */
export function candidates(name: BinName, env: string | undefined, bundledPath: string | null | undefined): Candidate[] {
  const all: Candidate[] = [];
  if (env) all.push({ path: env, from: 'env' });
  if (bundledPath) all.push({ path: unasar(bundledPath), from: 'static' });
  all.push({ path: `/opt/homebrew/bin/${name}`, from: 'homebrew' }, { path: `/usr/local/bin/${name}`, from: 'usr-local' }, { path: `/opt/local/bin/${name}`, from: 'macports' }, { path: name, from: 'PATH' });
  return all.filter((c, i) => all.findIndex((d) => d.path === c.path) === i);
}

/** What one candidate's check means: picked, or undefined to try the next. An env override is taken even when it does not run (the owner asked for it). */
const judge = (c: Candidate, r: boolean | string): Picked | undefined =>
  r === true ? { ...c, ok: true } : c.from === 'env' ? { ...c, ok: false, why: typeof r === 'string' ? r : 'does not run' } : undefined;

/** The first candidate that runs. An env override is taken even when it does not, with ok false. Undefined when nothing runs. */
export function pickRunnable(cands: readonly Candidate[], canRun: CanRun): Picked | undefined {
  for (const c of cands) { const p = judge(c, canRun(c.path)); if (p) return p; }
  return undefined;
}
/** pickRunnable with a check that does not block: one candidate at a time, same rules. */
export async function pickRunnableAsync(cands: readonly Candidate[], canRun: (path: string) => Promise<boolean | string>): Promise<Picked | undefined> {
  for (const c of cands) { const p = judge(c, await canRun(c.path)); if (p) return p; }
  return undefined;
}

type ExecErr = NodeJS.ErrnoException & { status?: number | null; signal?: NodeJS.Signals | null };
/** The errno name. libuv has none for -86 (EBADARCH on macOS: a binary for another CPU, and no Rosetta). */
export function errCode(e: unknown): string | undefined {
  const x = e as ExecErr | undefined;
  if (x?.errno === -86) return 'EBADARCH';
  return typeof x?.code === 'string' ? x.code : undefined;
}
const WHY: Record<string, string> = { EBADARCH: 'bad CPU type', ENOENT: 'not found', EACCES: 'not executable', ENOEXEC: 'not a program for this system', EPERM: 'not permitted', ETIMEDOUT: 'timed out' };
/** Why a binary did not run, in words for the log and the player. */
export function whyNotRun(e: unknown): string {
  const code = errCode(e); const x = e as ExecErr | undefined;
  if (code && WHY[code]) return WHY[code];
  if (typeof x?.status === 'number') return `exited with code ${x.status}`;
  const exit: unknown = (e as { code?: unknown } | undefined)?.code;   // execFile's callback puts the exit code in code
  if (typeof exit === 'number') return `exited with code ${exit}`;
  if (x?.signal) return `killed (${x.signal})`;
  return code || errMsg(e);
}
/** The program never started (missing, not executable, wrong CPU): nothing to do with its input. */
export function isSpawnError(e: unknown): boolean {
  const s = (e as ExecErr | undefined)?.syscall;
  return typeof s === 'string' && s.startsWith('spawn') && errCode(e) !== 'ETIMEDOUT';
}
/** "ffmpeg could not start: ENOENT (not found)". Only spawn failures get here, so it also marks the pick as failed (binFailed). */
export function startFailure(bin: BinName, e: unknown): string {
  binFailed(bin);
  const code = errCode(e); const why = whyNotRun(e);
  return `${bin} could not start: ${code && code !== why ? `${code} (${why})` : why}`;
}

/** A local binary that could not start: this machine's problem, not the torrent's. The message is for the player. Marks the pick as failed (binFailed). */
export class BinError extends Error {
  bin: BinName; path: string; why: string;
  constructor(bin: BinName, path: string, why: string) {
    super(`Kino could not run ${bin} on ${process.platform === 'darwin' ? 'this Mac' : 'this computer'} (${why}). See the server log.`);
    this.name = 'BinError'; this.bin = bin; this.path = path; this.why = why;
    binFailed(bin, path);
  }
}

/** `<bin> -version` runs. Blocks the event loop: only the first lookup uses it, at boot. */
export function runs(p: string): true | string {
  try { execFileSync(p, ['-version'], { timeout: 5000, stdio: 'ignore' }); return true; }
  catch (e) { return whyNotRun(e); }
}
/** runs() without blocking: the re-checks, which a request can set off. */
export function runsAsync(p: string, timeoutMs = 5000): Promise<true | string> {
  return new Promise((resolve) => {
    // Spawn failures: ENOENT and EACCES arrive in the callback, an unknown errno (-86, wrong CPU) is thrown right here.
    try { execFile(p, ['-version'], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err) => resolve(!err ? true : (err as { killed?: boolean }).killed ? 'timed out' : whyNotRun(err))); }
    catch (e) { resolve(whyNotRun(e)); }
  });
}

/** How long a pick that does not run, or that failed to start, stands before the candidates are tried again. An object so a test can shorten it. */
export const binRetry = { ms: 60_000 };
/** Looks up a binary. `before` is the pick it replaces (undefined the first time). */
export type Lookup = (name: BinName, env: string | undefined, before: Picked | null | undefined) => Picked | null;
/** The same lookup without blocking: a re-check. */
export type Recheck = (name: BinName, env: string | undefined, before: Picked | null) => Promise<Picked | null>;

/**
 * Picks per binary and override, cached. The first get() looks up synchronously (once per binary, at boot).
 * After that get() never waits: a pick that is missing, does not run, or failed to start (failed()) is checked
 * again in the background, once `retry.ms` has passed since the last lookup and one check at a time, and get()
 * returns the cached pick meanwhile. failed() starts that check at once, so a retry finds the new pick.
 * A pick that runs and never failed stands.
 */
export function pickCache(lookup: Lookup, recheck: Recheck, now: () => number = Date.now, retry: { ms: number } = binRetry) {
  type Entry = { pick: Picked | null; at: number; failed: boolean; checking?: Promise<void> };
  const m = new Map<string, Entry>();
  const due = (e: Entry) => !e.checking && !(e.pick?.ok && !e.failed) && now() - e.at >= retry.ms;
  const check = (key: string, name: BinName, env: string | undefined, e: Entry) => {
    e.checking = recheck(name, env, e.pick).then(
      (pick) => { m.set(key, { pick, at: now(), failed: false }); },
      () => { e.at = now(); e.checking = undefined; },
    );
  };
  const keyOf = (name: BinName, env: string | undefined) => `${name}\n${env ?? ''}`;
  return {
    get(name: BinName, env: string | undefined): Picked | null {
      const key = keyOf(name, env);
      const e = m.get(key);
      if (!e) { const pick = lookup(name, env, undefined); m.set(key, { pick, at: now(), failed: false }); return pick; }
      if (due(e)) check(key, name, env, e);
      return e.pick;
    },
    /** `name` failed to start (from `path`, when known): its pick is checked again, right away when the last lookup is over `retry.ms` old. */
    failed(name: BinName, path?: string): void {
      for (const [key, e] of m) {
        if (!key.startsWith(`${name}\n`) || (path !== undefined && e.pick && e.pick.path !== path)) continue;
        e.failed = true;
        if (due(e)) check(key, name, key.slice(name.length + 1) || undefined, e);
      }
    },
    /** A background check of this binary (and override) is running: get() answers from the pick it may replace. */
    checking(name: BinName, env: string | undefined): boolean { return !!m.get(keyOf(name, env))?.checking; },
    /** Resolves once every check in flight has finished. */
    settled(): Promise<void> { return Promise.all([...m.values()].map((e) => e.checking)).then(() => undefined); },
  };
}

const same = (a: Picked | null, b: Picked | null) => a?.path === b?.path && a?.ok === b?.ok;
/** Logs the first pick, and a later one only when it changed. */
function logPick(name: BinName, before: Picked | null | undefined, p: Picked | null, skipped: string[]): Picked | null {
  if (before !== undefined && same(before, p)) return p;
  if (!p) log.error(`no ${name} runs`, { tried: skipped });
  else if (!p.ok) log.warn(`${ENV[name]} does not run, using it anyway`, { path: p.path, why: p.why });
  else log.info(`${name} picked`, { path: p.path, from: p.from, ...(skipped.length ? { skipped } : {}) });
  return p;
}
/** The real lookups: run each candidate, blocking once at boot, in the background after that. */
const lookupBin: Lookup = (name, env, before) => {
  const skipped: string[] = [];
  const p = pickRunnable(candidates(name, env, BUNDLED[name]), (path) => { const r = runs(path); if (r !== true) skipped.push(`${path}: ${r}`); return r; }) ?? null;
  return logPick(name, before, p, skipped);
};
const recheckBin: Recheck = async (name, env, before) => {
  const skipped: string[] = [];
  const p = await pickRunnableAsync(candidates(name, env, BUNDLED[name]), async (path) => { const r = await runsAsync(path); if (r !== true) skipped.push(`${path}: ${r}`); return r; }) ?? null;
  return logPick(name, before, p, skipped);
};
const picks = pickCache(lookupBin, recheckBin);
const resolveBin = (name: BinName, env: string | undefined) => picks.get(name, env);
/** A spawn of `name` (from `path`, when known) failed to start: look for another binary in the background, at most once a minute. */
export function binFailed(name: BinName, path?: string): void { picks.failed(name, path); }
/** Resolves once every binary re-check in flight has finished. */
export function binChecks(): Promise<void> { return picks.settled(); }

/** The ffmpeg in use, as a live binding: modules that import it see the resolved path once anything has asked (the boot log does). */
export let FFMPEG = binOverride('ffmpeg') || bundled('ffmpeg');

/** The binary to spawn. An override is read at call time and used as given (tests point it at fakes); binStatus checks it. With nothing runnable it is the bundled one, so the spawn fails with the real reason. */
export function binPath(name: BinName): string {
  const p = binOverride(name) || resolveBin(name, undefined)?.path || bundled(name);
  if (name === 'ffmpeg') FFMPEG = p;
  return p;
}

/**
 * For /health and the boot log: whether a runnable binary was found, and the path Kino spawns. Cached and never waits;
 * checked again in the background, at most once a minute, while nothing runs. `checking`: such a check is running now,
 * so `ok` is the answer from before it (this call may be what started it).
 */
export function binStatus(name: BinName): { ok: boolean; path: string; from?: BinFrom; checking: boolean } {
  const env = binOverride(name);
  const p = resolveBin(name, env);
  return { ok: !!p?.ok, path: binPath(name), from: p?.from, checking: picks.checking(name, env) };
}
