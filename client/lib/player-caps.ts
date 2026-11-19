import type { Target } from '../../server/types.js';

const ua = navigator.userAgent;
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg/.test(ua);
export const isTouch = navigator.maxTouchPoints > 0;

export function canPlayNativeHls(): boolean {
  const v = document.createElement('video');
  return !!v.canPlayType('application/vnd.apple.mpegurl');
}
export function target(): Target { return isIOS || isSafari ? 'ios' : 'browser'; }

/** AV1 Main profile, level 4.0 (1080p), 10 bit: what AV1 releases mostly are. */
const AV1 = 'av01.0.08M.10';
/** Whether `supports` takes AV1 in MP4 or WebM (Chromium also plays Matroska through its WebM demuxer). */
export function av1Playable(supports: (mime: string) => boolean): boolean {
  return ['mp4', 'webm'].some((c) => supports(`video/${c}; codecs="${AV1}"`));
}

/** VP9 profile 0, level 1.0, 8 bit. */
const VP9 = 'vp09.00.10.08';
/**
 * Whether hls.js can play VP9 copied into fMP4 HLS: Media Source Extensions take VP9 in MP4 (`mse` is
 * MediaSource.isTypeSupported). Only this, not the element's canPlayType: the copy plays through hls.js.
 */
export function vp9Copyable(mse: (mime: string) => boolean): boolean { return mse(`video/mp4; codecs="${VP9}"`); }

/** The streams query for what a browser decodes besides H.264, so the ranking charges it no transcode (server/score.ts). */
export function decodeQuery(c: { hevc?: boolean; av1?: boolean }): string { return `${c.hevc ? '&hevc=1' : ''}${c.av1 ? '&av1=1' : ''}`; }

/** What this browser can decode natively, so the server can pick direct play. */
export function caps(): { hevc: boolean; mkv: boolean; av1: boolean; vp9: boolean } {
  const v = document.createElement('video');
  const supports = (mime: string) => !!v.canPlayType(mime) || (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime));
  const hevc = supports('video/mp4; codecs="hvc1.1.6.L93.B0"');
  // Chromium demuxes Matroska through its WebM demuxer; Firefox and Safari do not.
  const mkv = /Chrome|Chromium|Edg/.test(ua) && !isIOS;
  const vp9 = typeof MediaSource !== 'undefined' && vp9Copyable((m) => MediaSource.isTypeSupported(m));
  return { hevc, mkv, av1: av1Playable(supports), vp9 };
}
