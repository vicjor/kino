// Minimal WebVTT cue parser. The server always serves WebVTT, so we only parse
// that. Times are returned in seconds for VTTCue.
export interface Cue { start: number; end: number; text: string }

// [hh:]mm:ss.mmm: WebVTT lets the hour go below 1:00:00 (ffmpeg writes it that way).
const TS = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})/;
function ts(s: string): number {
  const m = TS.exec(s.trim());
  if (!m) return NaN;
  return +(m[1] ?? 0) * 3600 + +m[2] * 60 + +m[3] + Number(`0.${m[4]}`);
}

export function parseVtt(text: string): Cue[] {
  const out: Cue[] = [];
  const body = text.replace(/\r/g, '').replace(/^﻿?WEBVTT[^\n]*\n/, '');
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = 0;
    if (!lines[0].includes('-->')) i = 1; // skip cue id / NOTE
    const tl = lines[i];
    if (!tl || !tl.includes('-->')) continue;
    const [a, b] = tl.split('-->');
    const start = ts(a); const end = ts(b);
    if (isNaN(start) || isNaN(end)) continue;
    // strip position/align settings and inline tags for cleaner rendering
    const txt = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '');
    out.push({ start, end, text: txt });
  }
  return out;
}

/**
 * How far up from the foot of the picture a subtitle sits, as a VTTCue line (negative counts lines from the bottom).
 * The controls only push it up when they cover the picture: on a phone held upright the picture is a strip in the
 * middle with the controls below it, so the subtitle stays near its edge, as in any video app.
 */
export function cueLineFor(controlsShown: boolean, controlsCoverPicture: boolean, pictureHeight: number): number {
  if (controlsShown && controlsCoverPicture) return -6;
  return pictureHeight < 420 ? -2 : -3;
}
