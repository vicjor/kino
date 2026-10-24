import { spawn, type ChildProcess } from 'node:child_process';
import { binPath, isSpawnError, startFailure } from '../media/bins.js';
import { killOnShutdown } from '../lifecycle.js';
import { httpError } from '../errors.js';
import { logger } from '../log.js';
import { parseVtt, type Cue } from './srt2vtt.js';

const log = logger('subs.sync');
export const RATE = 8000;
export const FRAME_MS = 20;

/**
 * Speech activity per frame from 8 kHz mono PCM: frame RMS against an adaptive threshold
 * (a bit above the quiet half of the window). Music and crowd noise still count as speech,
 * which is fine: the subtitle signal only needs to line up with "something is being said".
 */
export function speechFrames(pcm: Int16Array, rate = RATE, frameMs = FRAME_MS): Uint8Array {
  const n = Math.floor(rate * frameMs / 1000);
  const frames = Math.floor(pcm.length / n);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0; const off = f * n;
    for (let i = 0; i < n; i++) { const v = pcm[off + i] / 32768; acc += v * v; }
    rms[f] = Math.sqrt(acc / n);
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.4)] || 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const thr = floor + (loud - floor) * 0.35;
  const out = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) out[f] = rms[f] > thr ? 1 : 0;
  return out;
}

/** Cue activity per frame over [fromMs, fromMs + frames*frameMs). */
export function cueFrames(cues: Cue[], fromMs: number, frames: number, frameMs = FRAME_MS): Uint8Array {
  const out = new Uint8Array(frames);
  for (const c of cues) {
    const a = Math.max(0, Math.floor((c.start - fromMs) / frameMs));
    const b = Math.min(frames, Math.ceil((c.end - fromMs) / frameMs));
    for (let f = a; f < b; f++) out[f] = 1;
  }
  return out;
}

/**
 * The shift (in frames) that best lines the cue signal up with speech. Positive means the
 * subtitles are early and need to move later, which is what the player's offset does.
 * Score is agreement over the frames where either signal is on, so 1 is perfect.
 */
export function bestShift(audio: Uint8Array, cues: Uint8Array, maxShift: number): { shift: number; score: number } {
  const n = Math.min(audio.length, cues.length);
  let best = 0, bestScore = -1;
  for (let s = -maxShift; s <= maxShift; s++) {
    let both = 0, either = 0;
    for (let i = 0; i < n; i++) {
      const j = i - s;                       // cue at i moved later by s lands at audio i
      const c = j >= 0 && j < n ? cues[j] : 0;
      const a = audio[i];
      if (a && c) both++;
      if (a || c) either++;
    }
    const score = either ? both / either : 0;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { shift: best, score: bestScore };
}

/** Read `durSec` seconds of mono 8 kHz PCM from `fromSec` in a media URL. */
function readPcm(url: string, fromSec: number, durSec: number, timeoutMs = 60_000): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(fromSec), '-i', url, '-t', String(durSec), '-vn', '-sn', '-dn', '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
    let p: ChildProcess;
    // An unknown errno (a binary for another CPU) throws here instead of emitting 'error'.
    try { p = killOnShutdown(spawn(binPath('ffmpeg'), args, { stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (e) { reject(new Error(startFailure('ffmpeg', e))); return; }
    const chunks: Buffer[] = []; let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Audio read timed out')); }, timeoutMs);
    p.stdout!.on('data', (c: Buffer) => chunks.push(c));
    p.stderr!.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', (e) => { clearTimeout(t); reject(isSpawnError(e) ? new Error(startFailure('ffmpeg', e)) : e); });
    p.on('close', (code) => {
      clearTimeout(t);
      const buf = Buffer.concat(chunks);
      if (!buf.length) return reject(new Error(`No audio read (${code}): ${err.trim().split('\n').pop() || ''}`));
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

/**
 * Align a subtitle file to the audio around `fromSec`. Windows of three minutes, offsets up to
 * a minute either way. Returns the offset to add to the cues and how well it fits.
 */
export async function syncSubtitle(vtt: string, sourceUrl: string, fromSec: number, opts: { windowSec?: number; maxShiftSec?: number } = {}): Promise<{ offsetMs: number; score: number }> {
  const windowSec = opts.windowSec ?? 180;
  const maxShiftSec = opts.maxShiftSec ?? 60;
  const from = Math.max(0, fromSec - windowSec / 2);
  const cues = parseVtt(vtt);
  if (!cues.length) throw httpError(422, 'No cues in this subtitle');
  const pcm = await readPcm(sourceUrl, from, windowSec);
  const audio = speechFrames(pcm);
  const c = cueFrames(cues, from * 1000, audio.length);
  if (!c.some((x) => x)) throw httpError(422, 'No subtitles in this part of the film; try again from a scene with dialogue');
  const r = bestShift(audio, c, Math.round(maxShiftSec * 1000 / FRAME_MS));
  const offsetMs = r.shift * FRAME_MS;
  log.info('synced', { from, offsetMs, score: +r.score.toFixed(3) });
  return { offsetMs, score: r.score };
}
