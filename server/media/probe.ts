import { execFile } from 'node:child_process';
import { logger, errMsg } from '../log.js';
import { httpError, type HttpError } from '../errors.js';
import { binPath, BinError, errCode, isSpawnError, whyNotRun } from './bins.js';
import { getTorrent } from '../torrent.js';
import type { ProbeInfo } from '../types.js';

const log = logger('probe');
/** ProbeInfo plus what only the server needs. bframes: the video has B-frames (ffprobe's has_b_frames, the decoder's reorder delay, which ffmpeg -ss reads), undefined when ffprobe did not say. */
export type Probed = ProbeInfo & { hdr?: boolean; bframes?: boolean };
/** Probes by file key, least recently asked first. One in flight is shared by every caller; a failed one is dropped so the next ask retries. */
const cache = new Map<string, { info?: Probed; pending: Promise<Probed> }>();
const CACHE_MAX = 200;

/** The ffprobe binary: FFPROBE_BIN read at call time, else the first one that runs. */
function ffprobeBin(): string { return binPath('ffprobe'); }

interface FfStream { index: number; codec_type: string; codec_name: string; profile?: string; level?: number; width?: number; height?: number; has_b_frames?: number; channels?: number; tags?: Record<string, string>; color_transfer?: string; disposition?: Record<string, number> }
export interface FfprobeOut { format?: { format_name?: string; duration?: string; start_time?: string }; streams?: FfStream[]; chapters?: { start_time?: string; end_time?: string; tags?: { title?: string } }[] }
/** Runs ffprobe on a URL and returns its parsed JSON. Injectable for tests. */
export type ProbeRunner = (url: string, timeoutMs: number) => Promise<FfprobeOut>;

const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO = new Set(['vorbis', 'opus']);

/**
 * ffprobe names Matroska and WebM alike ("matroska,webm"). It is WebM when every video and audio stream is a WebM codec
 * and the name, when known, ends in .webm: files are served with a MIME type from their extension, and a browser that
 * plays WebM but not Matroska refuses video/x-matroska whatever is inside.
 */
function isWebm(streams: FfStream[], name?: string): boolean {
  if (name != null && !/\.webm$/i.test(name)) return false;
  const av = streams.filter((s) => (s.codec_type === 'video' && !s.disposition?.attached_pic) || s.codec_type === 'audio');
  return av.length > 0 && av.every((s) => (s.codec_type === 'video' ? WEBM_VIDEO : WEBM_AUDIO).has(s.codec_name));
}

function container(fmt: string | undefined, streams: FfStream[], name?: string): string {
  const f = (fmt || '').toLowerCase();
  if (f.includes('matroska')) return isWebm(streams, name) ? 'webm' : 'mkv';
  if (f.includes('mp4') || f.includes('mov')) return 'mp4';
  if (f.includes('webm')) return 'webm';
  if (f.includes('avi')) return 'avi';
  if (f.includes('mpegts')) return 'ts';
  return f.split(',')[0] || 'unknown';
}

/** ffprobe's JSON to what Kino needs. Cover art (attached_pic) is not the video; HDR means a PQ or HLG transfer; bframes is has_b_frames above 0. `name` is the file's, to tell WebM from Matroska. */
export function toProbeInfo(data: FfprobeOut, name?: string): Probed {
  const streams = data.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  return {
    container: container(data.format?.format_name, streams, name),
    duration: Number(data.format?.duration || 0),
    startTime: Number(data.format?.start_time || 0) || 0,
    video: v ? { codec: v.codec_name, profile: v.profile, level: v.level, width: v.width, height: v.height } : undefined,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ index: s.index, codec: s.codec_name, channels: s.channels, lang: s.tags?.language, title: s.tags?.title })),
    subs: streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({ index: s.index, codec: s.codec_name, lang: s.tags?.language, title: s.tags?.title })),
    hdr: !!v && /smpte2084|arib-std-b67/i.test(v.color_transfer || ''),
    bframes: v?.has_b_frames === undefined ? undefined : v.has_b_frames > 0,
    chapters: (data.chapters || []).map((c) => ({ start: Number(c.start_time || 0), end: Number(c.end_time || 0), title: c.tags?.title })).filter((c) => isFinite(c.start)),
  };
}

const ffprobe: ProbeRunner = (url, timeoutMs) => new Promise((resolve, reject) => {
  const bin = ffprobeBin();
  // Spawn failures: ENOENT and EACCES arrive in the callback, an unknown errno (-86, wrong CPU) is thrown right here.
  const cannot = (e: unknown) => { const err = new BinError('ffprobe', bin, whyNotRun(e)); log.error('ffprobe could not start', { path: bin, code: errCode(e), why: err.why }); reject(err); };
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-analyzeduration', '30M', '-probesize', '30M', url];
  try {
    execFile(bin, args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err && isSpawnError(err)) return cannot(err);
      if (err) return reject(new Error(`ffprobe failed: ${stderr?.toString().trim() || err.message}`));
      try { resolve(JSON.parse(stdout.toString()) as FfprobeOut); } catch (e) { reject(e); }
    });
  } catch (e) { cannot(e); }
});

/** What /api/play throws when the probe fails. A local ffprobe that cannot start is this machine's problem, so no "slow torrent" advice. */
export function probeFailure(e: unknown): HttpError {
  if (e instanceof BinError) return httpError(500, e.message, 'tool-broken');
  return httpError(504, `Could not read the stream (${errMsg(e).slice(0, 120)}). Slow or dead torrent, try another source.`, 'unreadable');
}

/** The torrent file behind a probe key (`infoHash:fileIdx`), when it is loaded. */
function fileName(key: string): string | undefined {
  const [hash, idx] = key.split(':');
  return idx ? getTorrent(hash)?.files[Number(idx)]?.name : undefined;
}

export function probe(key: string, url: string, timeoutMs = 90_000, run: ProbeRunner = ffprobe): Promise<Probed> {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit.pending; }
  const pending = (async () => toProbeInfo(await run(url, timeoutMs), fileName(key)))();
  const entry: { info?: Probed; pending: Promise<Probed> } = { pending };
  pending.then((info) => {
    entry.info = info;
    log.info('probed', { key, container: info.container, video: info.video?.codec, audio: info.audio.map((a) => a.codec).join(','), duration: Math.round(info.duration), hdr: info.hdr });
  }, () => { if (cache.get(key) === entry) cache.delete(key); });
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return entry.pending;
}

export function probeCached(key: string): ProbeInfo | undefined { return cache.get(key)?.info; }
