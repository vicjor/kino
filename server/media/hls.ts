import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { HLS_DIR } from '../config.js';
import { logger } from '../log.js';
import { emit } from '../events.js';
import { httpError } from '../errors.js';
import { binPath, startFailure } from './bins.js';
import { dirSize, shortfall, diskFullMessage } from '../disk.js';
import type { Decision } from './decide.js';
import type { Probed } from './probe.js';
import type { ErrorCode } from '../types.js';

const log = logger('hls');
/** The ffmpeg binary: FFMPEG_BIN read at call time (a test points it elsewhere after import), else the first one that runs. */
function ffmpegBin(): string { return binPath('ffmpeg'); }
/** FFMPEG is a live binding for modules that read it at call time (subtitle extraction, sync); binStatus is for /health and the boot log. */
export { FFMPEG, binStatus } from './bins.js';

// Hardware H.264 encode via VideoToolbox on Apple Silicon/Intel Macs keeps the
// fans quiet: transcodes run on the media engine, not the CPU cores.
let HW = false;
export function hwEnabled(): boolean { return HW; }
export async function detectHwEncoder(): Promise<void> {
  if (process.env.KINO_NO_HW) { HW = false; return; }
  await new Promise<void>((resolve) => {
    let p: ChildProcess;
    try { p = spawn(ffmpegBin(), ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(); return; }   // an unknown errno throws instead of emitting 'error'
    let out = '';
    p.stdout?.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve());
    p.on('close', () => { HW = /h264_videotoolbox/.test(out); log.info('hw encoder', { videotoolbox: HW }); resolve(); });
  });
}

export interface HlsSession {
  id: string; infoHash: string; fileIdx: number; sourceUrl: string; dir: string;
  /** Source time (s) that maps to t=0 of this session's timeline. Requested on
   *  start, then corrected from the first segment: in copy mode ffmpeg begins at
   *  the keyframe BEFORE the requested offset, up to a GOP earlier. */
  startOffset: number;
  requestedOffset: number;
  decision: Decision; probe: Probed; proc?: ChildProcess; lastAccess: number;
  state: 'starting' | 'ready' | 'ended' | 'error'; error?: string; errorCode?: ErrorCode; owner?: string; triedNoTonemap?: boolean; triedSwEncode?: boolean;
  measured?: Promise<void>;
  /** ffmpeg frozen with SIGSTOP, segments kept. A seek back into its range wakes it instead of transcoding again. */
  parked?: boolean;
  /** The furthest segment a player has asked for (served()): where its buffer reaches. Unset until one asks. */
  seg?: number;
  /** ffmpeg frozen with SIGSTOP because it is far enough ahead of `seg` (throttle()). Parked or held, it stays frozen. */
  held?: boolean;
  /** SIGSTOP sent and not yet undone by a SIGCONT. */
  frozen?: boolean;
  /** When it was last frozen or nudged (nudge()). */
  frozenAt?: number;
  /** This ffmpeg encodes on VideoToolbox, which gives up on a process frozen too long. */
  hw?: boolean;
  /** Times throttle() has held it: only the first is logged at info. */
  holds?: number;
}

const sessions = new Map<string, HlsSession>();
// Players stop fetching once their buffer is full, and a paused TV fetches
// nothing at all, so idle must be generous. Clients ping while mounted.
const IDLE_MS = 5 * 60_000;
const SEG_SEC = 4;
/** Parked sessions kept per owner. Two covers "resumed, jumped forward, came back". */
const PARKED_MAX = 2;

export function playlistName(): string { return 'index.m3u8'; }

/** ffmpeg argv for one session. `hw` is whether VideoToolbox is available (the module flag, passed in so tests can cover both). */
export function ffmpegArgs(s: HlsSession, { hw }: { hw: boolean }): string[] {
  const d = s.decision; const p = s.probe;
  const a: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  a.push('-seekable', '1', '-multiple_requests', '1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1');
  if (s.startOffset > 0) {
    // Copied video has to begin at the keyframe before the seek point. If the audio is re-encoded,
    // ffmpeg would trim it to the exact point, leaving up to a GOP of video with no audio, and
    // players that line the first audio sample up with the first frame (the Chromecast does)
    // then play the whole file out of sync by that much. Keep the audio from the keyframe too;
    // the session's startOffset is measured to that keyframe and callers seek forward to the
    // requested second.
    if (d.videoCopy && !d.audioCopy) a.push('-noaccurate_seek');
    a.push('-ss', String(s.startOffset));
  }
  a.push('-i', `${s.sourceUrl}${s.sourceUrl.includes('?') ? '&' : '?'}src=hls`);   // range.ts TRANSCODER_SRC: /health counts this read as the session, not a viewer
  a.push('-map', '0:v:0');
  if (d.audioIndex >= 0) a.push('-map', `0:${d.audioIndex}`);
  a.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
  if (d.videoCopy) {
    a.push('-c:v', 'copy');
    if (p.video?.codec === 'hevc') a.push('-tag:v', 'hvc1');
    if (d.segment === 'mpegts') a.push('-bsf:v', 'h264_mp4toannexb');
  } else {
    const h = p.video?.height || 1080;
    const vf: string[] = [];
    if (p.hdr && !s.triedNoTonemap) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
    if (h > 1080) vf.push("scale=-2:1080");
    vf.push('format=yuv420p');
    a.push('-vf', vf.join(','));
    // -g alone assumes 24 fps (30 fps would cut ~6.4 s segments): force a keyframe on every segment boundary too.
    const gop = String(SEG_SEC * 24);
    const keys = `expr:gte(t,n_forced*${SEG_SEC})`;
    if (hw && !s.triedSwEncode) {
      const br = h > 1080 || (p.video?.width || 0) > 1920 ? '6500k' : '4500k';
      a.push('-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', br, '-maxrate', br, '-bufsize', '9000k', '-realtime', '1', '-g', gop, '-force_key_frames', keys);
    } else {
      a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', '4.1', '-g', gop, '-keyint_min', '24', '-sc_threshold', '0', '-force_key_frames', keys, '-threads', '0');
    }
  }
  if (d.audioIndex >= 0) {
    if (d.audioCopy) a.push('-c:a', 'copy');
    else a.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  }
  a.push('-f', 'hls', '-hls_time', String(SEG_SEC), '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file', '-start_number', '0');
  if (d.segment === 'fmp4') a.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(s.dir, 'seg%05d.m4s'));
  else a.push('-hls_segment_type', 'mpegts', '-hls_segment_filename', path.join(s.dir, 'seg%05d.ts'));
  a.push(path.join(s.dir, playlistName()));
  return a;
}

function spawnFfmpeg(s: HlsSession): void {
  const argv = ffmpegArgs(s, { hw: HW });
  if (!s.measured) s.measured = measureStart(s).catch(() => undefined);
  s.hw = HW && !s.decision.videoCopy && !s.triedSwEncode;
  log.info('ffmpeg start', { id: s.id, mode: s.decision.mode, offset: s.startOffset, seg: s.decision.segment, hw: s.hw, tonemap: !!(s.probe.hdr && !s.triedNoTonemap) });
  log.debug('argv', { argv: argv.join(' ') });
  const fail = (error: string, extra: Record<string, unknown> = {}, code: ErrorCode = 'transcode-failed') => {
    setState(s, 'error', error, code);
    log.error('ffmpeg failed', { id: s.id, err: error, ...extra });
  };
  let proc: ChildProcess;
  // An unknown errno (-86, a binary for another CPU) throws here instead of emitting 'error'.
  try { proc = spawn(ffmpegBin(), argv, { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { s.proc = undefined; fail(startFailure('ffmpeg', e), {}, 'tool-broken'); return; }
  s.proc = proc; s.frozen = false; s.held = false;
  signal(s);   // a retry of a parked session starts frozen too
  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  const startedAt = Date.now();
  // A binary that cannot be spawned (ENOENT, EACCES) emits 'error' and 'close', never 'exit'.
  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (s.proc !== proc) return;
    if (proc.pid != null) { log.warn('ffmpeg signal failed', { id: s.id, err: err.message }); return; } // a kill that did not land, ffmpeg still runs
    fail(startFailure('ffmpeg', err), {}, 'tool-broken');
  });
  proc.on('exit', (code, sig) => {
    if (s.proc !== proc) return; // stop() clears s.proc before it kills, so Kino's own kills end here
    const ran = Date.now() - startedAt;
    if (code === 0) { setState(s, 'ended'); log.info('ffmpeg done', { id: s.id }); return; }
    // Killed from outside (the OS, a stray kill): no fallback encode would help, say so.
    if (sig === 'SIGKILL' || sig === 'SIGTERM') { fail(`ffmpeg was killed (${sig})`); return; }
    if (s.probe.hdr && !s.triedNoTonemap && ran < 15_000) {
      log.warn('tonemap chain failed, retrying without', { id: s.id, err: stderr.slice(-300) });
      s.triedNoTonemap = true;
      spawnFfmpeg(s);
      return;
    }
    if (HW && !s.decision.videoCopy && !s.triedSwEncode && ran < 15_000) {
      log.warn('hw encode failed, retrying with libx264', { id: s.id, err: stderr.slice(-300) });
      s.triedSwEncode = true;
      spawnFfmpeg(s);
      return;
    }
    fail(stderr.trim().split('\n').pop() || `ffmpeg exited ${code ?? sig}`, { code, sig });
  });
  // Ready once the playlist lists a segment: looked at as ffmpeg writes each file. Gives up once this ffmpeg is not the session's, or the state moved on.
  const listed = () => { try { return /#EXTINF/.test(fs.readFileSync(path.join(s.dir, playlistName()), 'utf8')); } catch { return false; } };
  void waitFor(s.id, () => (s.proc !== proc || s.state !== 'starting' ? false : listed() || undefined)).then((ok) => {
    if (!ok) return;
    let late: NodeJS.Timeout | undefined;
    void Promise.race([s.measured, new Promise((r) => { late = setTimeout(r, 4000); })]).finally(() => {
      clearTimeout(late);
      if (s.proc !== proc || s.state !== 'starting') return;
      setState(s, 'ready');
    });
  });
}

/** The session's state from now on: tell the clients, wake whoever waits on it. */
function setState(s: HlsSession, state: 'ready' | 'ended' | 'error', error?: string, code?: ErrorCode): void {
  s.state = state;
  if (error !== undefined) s.error = error;
  if (code) s.errorCode = code;
  emit('hls.state', { sessionId: s.id, state, error, code });
  poke(s.id);
}

/*
 * Waiting on ffmpeg. A player's first playlist, a seek and a segment asked for before it is written all wait on
 * ffmpeg's next file. One recursive fs.watch on HLS_DIR (an event per file, named `<session id>/<file>`) wakes that
 * session's waiters as ffmpeg renames a file into place; setState and stop wake them too. FSEvents can drop events
 * (just after a watch starts, and while another watch on the same loop opens or closes), so a poll every WAIT.pollMs
 * wakes every waiter as well, no slower than the 200 to 300 ms polls this replaced. One watch for all sessions, so
 * sessions starting and stopping do not make each other miss events. Watch and poll run only while someone waits.
 */
/** How often waiters look again with no file event. */
export const WAIT = { pollMs: 250 };
const waiters = new Map<string, Set<() => void>>();
let watch: fs.FSWatcher | undefined;
let poll: NodeJS.Timeout | undefined;
let watchWarned = false;

/** Run the waiters of session `id`, or of every session. */
function poke(id?: string): void {
  for (const [k, fns] of [...waiters]) if (id === undefined || k === id) for (const fn of [...fns]) fn();
}

function watchFailed(e: unknown): void {
  if (!watchWarned) log.warn('cannot watch the HLS folder, polling', { err: e instanceof Error ? e.message : String(e) });
  watchWarned = true;
}

/** Calls fn on every file event in session `id`'s folder, its state changes and every WAIT.pollMs, until the returned function is called. */
function onChange(id: string, fn: () => void): () => void {
  const fns = waiters.get(id) ?? new Set<() => void>();
  waiters.set(id, fns);
  fns.add(fn);
  if (!watch) {
    try {
      const w = fs.watch(HLS_DIR, { recursive: true }, (_e, name) => poke(name ? String(name).split(path.sep)[0] : undefined));
      w.on('error', (e) => { w.close(); if (watch === w) watch = undefined; watchFailed(e); });
      watch = w;
    } catch (e) { watchFailed(e); }   // the poll alone
  }
  poll ??= setInterval(() => poke(), WAIT.pollMs);
  return () => {
    fns.delete(fn);
    if (!fns.size && waiters.get(id) === fns) waiters.delete(id);
    if (waiters.size) return;
    watch?.close(); watch = undefined;
    clearInterval(poll); poll = undefined;
  };
}

/** check() now, then on every wake-up of session `id`, until it answers (anything but undefined). After `ms`, if given, one last check() whatever it says. */
function waitFor<T>(id: string, check: () => T | undefined, ms?: number): Promise<T | undefined> {
  const first = check();
  if (first !== undefined) return Promise.resolve(first);
  return new Promise((resolve) => {
    let open = true;
    const done = (v: T | undefined) => { if (!open) return; open = false; clearTimeout(timer); off(); resolve(v); };
    const off = onChange(id, () => { const v = check(); if (v !== undefined) done(v); });
    const timer = ms === undefined ? undefined : setTimeout(() => done(check()), ms);
  });
}

/** Is `file` of this session on disk, waiting up to `ms` for ffmpeg to rename it into place (temp_file)? False once the session is stopped. */
export async function waitFile(s: HlsSession, file: string, ms: number): Promise<boolean> {
  const p = path.join(s.dir, file);
  return !!(await waitFor(s.id, () => (fs.existsSync(p) ? true : sessions.has(s.id) ? undefined : false), ms));
}

/** In copy mode the session starts at the first keyframe ffmpeg reads after its
 *  input seek, and that keyframe becomes t=0 (its DTS, to be exact, which is what
 *  fMP4 tfdt / hls.js initPTS use). Where that is depends on the container: MKV
 *  and MP4 seek by index to the keyframe at or before the offset, MPEG-TS seeks by
 *  bytes and lands on the keyframe after it. So ffprobe seeks exactly as ffmpeg
 *  did and the first keyframe it reads is the start: exact, and quick because
 *  ffmpeg has just pulled the same bytes. Transcode mode drops frames before the
 *  offset, so it is exact already. */
async function measureStart(s: HlsSession): Promise<void> {
  if (s.requestedOffset <= 0 || !s.decision.videoCopy) return;
  const ss = s.requestedOffset; const t0 = s.probe.startTime || 0; const box = s.probe.container;
  // The probe's has_b_frames, else a guess (most MKV and TS video has B-frames). This read tells too, as ffmpeg saw it: a mismatch reads again.
  let bframes = s.probe.bframes ?? box !== 'mp4';
  const read = (span: number) => readKeyframes(s.sourceUrl, seekTarget(ss, t0, seeksEarly(box, bframes)), span);
  for (const span of [10, 40]) {
    let r = await read(span);
    if (r && seeksEarly(box, r.bframes) !== seeksEarly(box, bframes)) { bframes = r.bframes; r = await read(span); }
    if (!r) return;   // ffprobe failed or could not start: keep the requested offset
    if (r.key !== undefined) {
      const actual = Math.max(0, +(r.key - t0).toFixed(3));
      if (Math.abs(actual - ss) > 0.02) { s.startOffset = actual; log.info('start corrected', { id: s.id, requested: ss, actual }); }
      return;
    }
  }
}

/** ffprobe seeks like ffmpeg -ss to `target` (stream time) and reads `span` seconds of video packets. Undefined when it fails. */
function readKeyframes(url: string, target: number, span: number): Promise<KeyframeRead | undefined> {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${Math.max(0, target).toFixed(6)}%+${span}`, '-show_entries', 'packet=pts_time,dts_time,flags:stream=has_b_frames', '-of', 'json', url];
  return new Promise((resolve) => {
    try { execFile(binPath('ffprobe'), args, { timeout: 6000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : parseKeyframeRead(String(stdout)))); }
    catch { resolve(undefined); }   // an unknown errno (a binary for another CPU) throws instead of calling back
  });
}

export interface KeyframeRead { /** DTS (PTS when there is none) of the first keyframe read, in stream time. */ key?: number; bframes: boolean }
/** ffprobe's JSON for `packet=pts_time,dts_time,flags:stream=has_b_frames`: the first keyframe in read order, and whether the video has B-frames. */
export function parseKeyframeRead(json: string): KeyframeRead | undefined {
  let j: { packets?: { pts_time?: string; dts_time?: string; flags?: string }[]; streams?: { has_b_frames?: number }[] };
  try { j = JSON.parse(json); } catch { return undefined; }
  const bframes = (j.streams?.[0]?.has_b_frames ?? 0) > 0;
  for (const p of j.packets || []) {
    if (!p.flags?.includes('K')) continue;
    const d = p.dts_time === undefined ? NaN : Number(p.dts_time);
    const t = isFinite(d) ? d : Number(p.pts_time);
    if (isFinite(t)) return { key: t, bframes };
  }
  return { bframes };
}

/** ffmpeg -ss seeks 3/23 s early when the video has B-frames (its dts heuristic), except in MP4, whose demuxer seeks by PTS. */
export const seeksEarly = (container: string, bframes: boolean): boolean => bframes && container !== 'mp4';
/** Where ffmpeg -ss `ss` seeks, in stream time: -ss counts from the container's start time (~1.4 s into an MPEG-TS), ffprobe's -read_intervals does not. */
export function seekTarget(ss: number, startTime: number, early: boolean): number { return ss + startTime - (early ? 3 / 23 : 0); }

/** Resolves once the session has its first segment (or has finished), the moment setState says so. Rejects at once when it fails or is stopped, and after `ms` (503). */
export async function waitReady(s: HlsSession, ms: number): Promise<void> {
  const r = await waitFor(s.id, () => {
    if (s.state === 'ready' || s.state === 'ended') return true;
    if (s.state === 'error') return httpError(500, `Transcoder failed: ${s.error}`, s.errorCode ?? 'transcode-failed');
    if (!sessions.has(s.id)) return httpError(410, 'Stream session was replaced', 'session-gone');
    return undefined;
  }, ms);
  if (r === undefined) throw Object.assign(new Error('Transcoder is still starting, retry'), { status: 503 });
  if (r !== true) throw r;
}

export function start(opts: { infoHash: string; fileIdx: number; sourceUrl: string; startOffset: number; decision: Decision; probe: Probed; owner?: string }): HlsSession {
  // One running ffmpeg per owner. Earlier sessions of the same file that have media, running or finished,
  // are parked (frozen, segments kept) so a rewind into them is instant; anything else of this owner's goes.
  if (opts.owner) {
    for (const s of sessions.values()) {
      if (s.owner !== opts.owner) continue;
      if (s.infoHash === opts.infoHash && s.fileIdx === opts.fileIdx && hasMedia(s)) park(s); else stop(s.id);
    }
    prunePinned(opts.owner);
  }
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(HLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const s: HlsSession = { id, dir, lastAccess: Date.now(), state: 'starting', requestedOffset: opts.startOffset, ...opts };
  sessions.set(id, s);
  ticker ??= setInterval(throttleAll, THROTTLE_MS).unref();
  spawnFfmpeg(s);
  return s;
}

export function get(id: string): HlsSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastAccess = Date.now();
  return s;
}

/** Running past its first segment, or finished: its segments can be played. */
const hasMedia = (s: HlsSession) => s.state === 'ready' || s.state === 'ended';

/** Does this session already hold the media for source time t (with a little slack at the live edge)? */
export function covers(s: HlsSession, t: number): boolean {
  return hasMedia(s) && t >= s.startOffset && t <= s.startOffset + producedSeconds(s) - 1;
}

/** SIGSTOP or SIGCONT so ffmpeg runs exactly while the session is neither parked nor held. */
function signal(s: HlsSession): void {
  const stop = !!(s.parked || s.held);
  if (stop === !!s.frozen) return;
  s.frozen = stop; s.frozenAt = Date.now();
  if (s.proc && s.proc.exitCode == null) try { s.proc.kill(stop ? 'SIGSTOP' : 'SIGCONT'); } catch { /* already gone */ }
}

/**
 * VideoToolbox drops the encoder of a process frozen for more than about a minute and a half: the next frame after
 * SIGCONT fails (-17691) and the session dies. On this Mac a 90 s freeze survived and 120 s did not; a 20 ms SIGCONT
 * every 60 s kept one alive through 330 s. So a frozen hw ffmpeg, held or parked, runs a moment every `everyMs`
 * (a fraction of a segment each time). Copy and libx264 sessions stay frozen (a 330 s remux freeze survived).
 */
export const NUDGE = { everyMs: 30_000, runMs: 100 };
function nudge(s: HlsSession, now: number): void {
  const proc = s.proc;
  if (!s.frozen || !s.hw || !proc || proc.exitCode != null || now - (s.frozenAt ?? now) < NUDGE.everyMs) return;
  s.frozenAt = now;
  try { proc.kill('SIGCONT'); } catch { return; }
  setTimeout(() => {
    if (s.proc !== proc || !s.frozen || proc.exitCode != null) return;   // let go meanwhile, or gone
    try { proc.kill('SIGSTOP'); } catch { /* already gone */ }
    s.frozenAt = Date.now();
  }, NUDGE.runMs).unref();
}
function park(s: HlsSession): void {
  if (s.parked) return;
  s.parked = true; s.lastAccess = Date.now();
  signal(s);
  log.info('session parked', { id: s.id, from: s.startOffset, has: Math.round(producedSeconds(s)) });
}
function wake(s: HlsSession): void {
  if (!s.parked) return;
  s.parked = false; s.lastAccess = Date.now();
  signal(s);   // still held: frozen until its player asks near the edge
  log.info('session woken', { id: s.id, from: s.startOffset, held: !!s.held });
}
function prunePinned(owner: string): void {
  const parked = [...sessions.values()].filter((x) => x.owner === owner && x.parked).sort((a, b) => b.lastAccess - a.lastAccess);
  for (const x of parked.slice(PARKED_MAX)) stop(x.id);
}

/**
 * Seek outside the current session's produced range. Rewinding into something already transcoded
 * (this session, or a parked one of the same file) is a switch, not a new ffmpeg.
 */
export function seek(s: HlsSession, time: number): HlsSession {
  const t = Math.max(0, Math.floor(time));
  if (covers(s, t)) { s.lastAccess = Date.now(); return s; }
  const twin = [...sessions.values()].find((x) => x !== s && x.owner === s.owner && x.infoHash === s.infoHash && x.fileIdx === s.fileIdx && covers(x, t));
  if (twin) { park(s); wake(twin); if (s.owner) prunePinned(s.owner); return twin; }
  return start({ infoHash: s.infoHash, fileIdx: s.fileIdx, sourceUrl: s.sourceUrl, startOffset: t, decision: s.decision, probe: s.probe, owner: s.owner });
}

/** Seconds of media available from startOffset in this session. */
export function producedSeconds(s: HlsSession): number {
  try {
    const pl = fs.readFileSync(path.join(s.dir, playlistName()), 'utf8');
    let t = 0; for (const m of pl.matchAll(/#EXTINF:([\d.]+)/g)) t += parseFloat(m[1]);
    return t;
  } catch { return 0; }
}

export function stop(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  const proc = s.proc; s.proc = undefined;
  poke(id);   // its waiters give up now, and the folder watch closes with the last of them
  if (proc && proc.exitCode == null) { proc.kill('SIGKILL'); }
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 500);
  log.info('session stopped', { id });
}

export function stopAll(): void { for (const id of [...sessions.keys()]) stop(id); }
export function active(): HlsSession[] { return [...sessions.values()]; }

/*
 * Throttle. Every session writes the rest of the film as fast as ffmpeg can, so one being watched could fill the disk.
 * Old segments cannot go: the EVENT playlist still lists them, and hls.js (90 s back buffer), Safari and the Player's
 * seekTo seek inside it without asking the server, so a rewind would fetch a deleted segment, wait, 404 and end the
 * stream (hls.js never retries a 4xx). Instead ffmpeg is frozen (SIGSTOP, as park does) once it is far ahead of the
 * furthest segment a player has asked for, and let go (SIGCONT) a little later. Same process, playlist and timestamps:
 * players only see the playlist stop growing for a while, as it does today when the torrent is slow. The step between
 * hold and let go is short (AHEAD.release) so that while is about half a minute of playback, not minutes: hls.js waits
 * out an unchanged playlist forever, Safari and the Chromecast are less known. Until a player has asked for a segment
 * (served()) a session is never held: with no playhead known, holding could starve it.
 */

/** How far ffmpeg may run past the furthest segment asked for: maxSec of media or maxBytes on disk, never under minSec; minSec when the disk is short. Let go `release` seconds under the cap. */
export const AHEAD = { maxSec: 10 * 60, maxBytes: 2 * 1024 ** 3, minSec: 2 * 60, release: 30 };
const THROTTLE_MS = 2000;
let ticker: NodeJS.Timeout | undefined;

/** seg00042.ts or seg00042.m4s: 42. Undefined for the playlist, init.mp4 or anything else. */
export function segIndex(file: string): number | undefined {
  const m = /^seg(\d+)\.(?:ts|m4s)$/.exec(file);
  return m ? Number(m[1]) : undefined;
}

export interface Ahead { sec: number; bytes: number }
/** What a playlist lists past segment `furthest`: seconds, and bytes on disk (`size` of each file). */
export function aheadOf(playlist: string, furthest: number, size: (file: string) => number): Ahead {
  let sec = 0, bytes = 0, dur = 0;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m) { dur = parseFloat(m[1]); continue; }
    const n = segIndex(line);
    if (n !== undefined && n > furthest) { sec += dur; bytes += size(line); }
  }
  return { sec, bytes };
}

/** The cap in seconds of media for this much ahead: maxSec, or maxBytes at its bitrate if that comes first, never under minSec. With the disk short, minSec. */
export function capSec(a: Ahead, short: boolean): number {
  if (short) return AHEAD.minSec;
  const byBytes = a.bytes > 0 ? AHEAD.maxBytes * a.sec / a.bytes : Infinity;
  return Math.max(AHEAD.minSec, Math.min(AHEAD.maxSec, byBytes));
}

/** Should ffmpeg be (or stay) held with this much ahead? Held over the cap, let go `release` under it: no stop and go every segment. */
export function shouldHold(a: Ahead, held: boolean, short: boolean): boolean {
  return a.sec > capSec(a, short) - (held ? AHEAD.release : 0);
}

/** Hold or let go of one session's ffmpeg by how far it is ahead of its player. A parked one is frozen anyway: a wake and the next ask decide. */
function throttle(s: HlsSession, short: boolean): void {
  if (s.parked) return;
  let hold = false; let a: Ahead | undefined;
  if (s.seg !== undefined && s.state === 'ready' && s.proc && s.proc.exitCode == null) {
    let pl: string;
    try { pl = fs.readFileSync(path.join(s.dir, playlistName()), 'utf8'); } catch { return; }
    a = aheadOf(pl, s.seg, (f) => { try { return fs.statSync(path.join(s.dir, f)).size; } catch { return 0; } });
    hold = shouldHold(a, !!s.held, short);
  }
  if (hold === !!s.held) return;
  s.held = hold;
  signal(s);
  // Every half minute of playback while it runs ahead: the first hold of a session, and any for a short disk, say so.
  const info = hold && (!s.holds || short);
  if (hold) s.holds = (s.holds || 0) + 1;
  log[info ? 'info' : 'debug'](hold ? 'ffmpeg held, far ahead of the player' : 'ffmpeg let go', { id: s.id, seg: s.seg, aheadSec: a && Math.round(a.sec), aheadMB: a && Math.round(a.bytes / 1024 ** 2), diskShort: short });
}

const diskShort = () => !!shortfall(HLS_DIR);

/** Every session's throttle check and hw nudge: on a timer while sessions exist (a paused player asks for nothing). Exported for tests. */
export function throttleAll(): void {
  const short = diskShort(); const now = Date.now();
  for (const s of sessions.values()) { throttle(s, short); nudge(s, now); }
  if (!sessions.size && ticker) { clearInterval(ticker); ticker = undefined; }
}

/**
 * A player asked for `file` of this session. Call it before waiting for the file: an ask at or past the edge lets a
 * held ffmpeg go at once. The furthest segment asked for is where the player's buffer ends, so ffmpeg is held only
 * while every player of the session is far behind the edge.
 */
export function served(s: HlsSession, file: string): void {
  const n = segIndex(file);
  if (n === undefined) return;
  if (n > (s.seg ?? -1)) s.seg = n;
  throttle(s, diskShort());
}

/** Keepalive from a mounted player (paused players fetch nothing). */
export function touch(id: string): boolean { const s = sessions.get(id); if (s) s.lastAccess = Date.now(); return !!s; }

/**
 * The sessions to reap at `now`: idle past IDLE_MS unless `keep` holds them. The cast manager keeps the
 * session it is casting from (a paused TV fetches nothing); a parked one is nobody's viewer, kept or not.
 */
export function reapable(list: Iterable<HlsSession>, now: number, keep: (s: HlsSession) => boolean): HlsSession[] {
  const out: HlsSession[] = [];
  for (const s of list) if (now - s.lastAccess > IDLE_MS && (s.parked || !keep(s))) out.push(s);
  return out;
}

/** Set by the cast manager: is this the session casting now? Any other cast session reaps like an idle one. */
let castKeep: (s: HlsSession) => boolean = () => false;
export function setCastKeep(fn: (s: HlsSession) => boolean): void { castKeep = fn; }

/** Wake a parked session so it plays on after all. False when it is gone. */
export function revive(id: string): boolean { const s = sessions.get(id); if (s) wake(s); return !!s; }

/** Idle this long, a session is nobody's when the disk runs short: a mounted player pings every 45 s and fetches segments while it plays. */
const DISK_IDLE_MS = 2 * 60_000;

/**
 * Sessions to stop when the disk is `need` bytes short, in order, until their segments add up to it: parked ones
 * oldest first (nobody watches them), then idle ones, oldest first. Anyone watching stays, and so does the session
 * casting now (`keep`), parked or not: a paused TV fetches nothing, and a cast mid-seek parks the stream it still plays.
 */
export function diskVictims(list: Iterable<HlsSession>, now: number, need: number, keep: (s: HlsSession) => boolean, sizeOf: (s: HlsSession) => number): HlsSession[] {
  if (need <= 0) return [];
  const stoppable = [...list].filter((s) => !keep(s));
  const oldest = (a: HlsSession, b: HlsSession) => a.lastAccess - b.lastAccess;
  const order = [...stoppable.filter((s) => s.parked).sort(oldest), ...stoppable.filter((s) => !s.parked && now - s.lastAccess > DISK_IDLE_MS).sort(oldest)];
  const out: HlsSession[] = [];
  for (let freed = 0, i = 0; i < order.length && freed < need; i++) { out.push(order[i]); freed += sizeOf(order[i]); }
  return out;
}

export function reaper(): void {
  const now = Date.now();
  // Every session writes the whole rest of its film, so a full disk is not only a play-start problem.
  const short = shortfall(HLS_DIR);
  let need = short?.need ?? 0;
  for (const s of reapable(sessions.values(), now, castKeep)) {
    if (need > 0) need -= dirSize(s.dir);   // its segments go too: count them before stopping more
    log.info('reaping idle session', { id: s.id, owner: s.owner, parked: !!s.parked });
    stop(s.id);
  }
  if (!short || need <= 0) return;
  const victims = diskVictims(sessions.values(), now, need, castKeep, (s) => dirSize(s.dir));
  if (!victims.length) return;
  const error = diskFullMessage(short.free, short.min);
  log.warn('disk nearly full, stopping sessions', { free: short.free, min: short.min, stop: victims.map((s) => ({ id: s.id, owner: s.owner, parked: !!s.parked })) });
  for (const s of victims) {
    setState(s, 'error', error, 'disk-full');
    stop(s.id);
  }
}

export function wipeAll(): void {
  fs.rmSync(HLS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HLS_DIR, { recursive: true });
}
