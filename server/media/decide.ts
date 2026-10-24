import type { PlayMode, PlayRequest, ProbeInfo, Target } from '../types.js';

export interface Decision {
  mode: PlayMode;
  reason?: string;
  videoCopy: boolean;      // hls only
  audioCopy: boolean;
  segment: 'fmp4' | 'mpegts';
  audioIndex: number;      // absolute stream index
}

const AUDIO_WEB = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const AUDIO_MP4 = new Set(['aac', 'mp3']);

const LANG_ALIAS: Record<string, string> = { en: 'eng', english: 'eng', und: '', cze: 'ces', ger: 'deu', fre: 'fra', dut: 'nld', gre: 'ell', rum: 'ron', chi: 'zho' };
const norm = (l?: string) => { const x = (l || '').toLowerCase(); return LANG_ALIAS[x] ?? x; };
/** Pick the audio stream: explicit choice, else the first that matches the preferred languages (English
 *  first, by tag or by track title), else a track that is not marked as commentary, else the first. */
export function pickAudio(p: ProbeInfo, want?: number, langs: string[] = ['eng']): number {
  if (want != null && p.audio.some((a) => a.index === want)) return want;
  const prefs = [...new Set(['eng', ...langs.map(norm)])];
  for (const l of prefs) {
    const a = p.audio.find((x) => norm(x.lang) === l) || p.audio.find((x) => l === 'eng' && /english|\beng\b/i.test(x.title || ''));
    if (a) return a.index;
  }
  const plain = p.audio.find((x) => !/comment|description|descriptive/i.test(x.title || ''));
  return (plain || p.audio[0])?.index ?? -1;
}

type Caps = NonNullable<PlayRequest['caps']>;
type DecideOpts = { forceHls?: boolean; audioIndex?: number; caps?: Caps; hdr?: boolean };

/**
 * Video codecs besides H.264 that a target decodes, so they play as is or copy into HLS: HEVC on iOS always, HEVC and
 * AV1 in the browser only when the client says so (hls.js copies them into fMP4). iOS ignores caps.av1: its native HLS is
 * untested with AV1. The old Chromecast decodes nothing else.
 */
function copyableVideo(target: Target, caps: Caps = {}): string[] {
  if (target === 'ios') return ['hevc'];
  if (target === 'browser') return [...(caps.hevc ? ['hevc'] : []), ...(caps.av1 ? ['av1'] : [])];
  return [];
}

/** What each target plays as is. The old Chromecast: MP4, H.264, AAC or MP3, nothing else. */
function directRule(target: Target, extra: string[]): { containers: string[]; video: string[]; audio: Set<string> } {
  if (target === 'browser') return { containers: ['mp4', 'mkv', 'webm'], video: ['h264', 'vp8', 'vp9', ...extra], audio: AUDIO_WEB };
  if (target === 'ios') return { containers: ['mp4'], video: ['h264', ...extra], audio: AUDIO_MP4 };
  return { containers: ['mp4'], video: ['h264'], audio: AUDIO_MP4 };
}

/** The first rule that keeps this file from playing as is, or undefined when none does. */
function directBlocker(p: ProbeInfo, target: Target, a: ProbeInfo['audio'][number] | undefined, extra: string[], opts: DecideOpts): string | undefined {
  if (opts.forceHls) return 'requested';
  if (opts.hdr) return 'HDR needs tone-mapping';
  const r = directRule(target, extra);
  const v = p.video?.codec || 'none'; const ac = a?.codec || 'none';
  if (!r.containers.includes(p.container) || (target === 'browser' && p.container === 'mkv' && opts.caps?.mkv === false)) return `${p.container} container not supported on ${target}`;
  if (!r.video.includes(v)) return `${v} video not supported on ${target}`;
  if (!r.audio.has(ac)) return `${ac} audio not supported on ${target}`;
  if (a && p.audio.indexOf(a) > 0) return 'only the first audio track plays directly';
  return undefined;
}

export function decide(p: ProbeInfo, target: Target, opts: DecideOpts = {}): Decision {
  const v = p.video?.codec || 'none';
  const a = p.audio.find((x) => x.index === opts.audioIndex) || p.audio[0];
  const ac = a?.codec || 'none';
  const audioIndex = a?.index ?? -1;
  const extra = copyableVideo(target, opts.caps);
  const hdr = !!opts.hdr;

  const reason = directBlocker(p, target, a, extra, opts);
  if (!reason) return { mode: 'direct', videoCopy: true, audioCopy: true, segment: 'fmp4', audioIndex };

  const videoCopy = !hdr && (v === 'h264' || extra.includes(v));
  const audioCopy = ac === 'aac';
  const segment: Decision['segment'] = target === 'chromecast' ? 'mpegts' : 'fmp4';
  return { mode: videoCopy ? 'hls-copy' : 'hls-transcode', reason, videoCopy, audioCopy, segment, audioIndex };
}
