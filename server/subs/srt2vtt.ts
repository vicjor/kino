/** Decode subtitle bytes: UTF-8 (with/without BOM) else Windows-1252 (common for Norwegian .srt). */
export function decodeSubtitle(buf: Buffer, hint?: string): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (hint && /1252|latin|iso-8859-1|cp1252/i.test(hint)) return new TextDecoder('windows-1252').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

/** [hh:]mm:ss.mmm, comma or dot. The hour is optional: ffmpeg's webvtt muxer leaves it out below 1:00:00. */
const TS = /^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})/;
export function parseTs(s: string): number {
  const m = TS.exec(s.trim());
  if (!m) return NaN;
  return (+(m[1] ?? 0) * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0');
}
export function fmtTs(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const s = Math.floor((ms % 60000) / 1000); const f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

export interface Cue { start: number; end: number; text: string }

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = 0;
    if (!lines[0].includes('-->')) i = 1;   // SRT index or WebVTT cue id
    const tl = lines[i];
    if (!tl || !tl.includes('-->')) continue;
    const [a, b2] = tl.split('-->');
    const start = parseTs(a); const end = parseTs(b2);
    if (isNaN(start) || isNaN(end)) continue;
    const body = lines.slice(i + 1).join('\n').replace(/<\/?font[^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '');
    cues.push({ start, end, text: body });
  }
  return cues;
}

export function parseVtt(text: string): Cue[] {
  return parseSrt(text.replace(/^WEBVTT[^\n]*\n/, '').replace(/^(NOTE|STYLE|REGION)[\s\S]*?\n\n/gm, ''));
}

export function toVtt(cues: Cue[], offsetMs = 0): string {
  const out = ['WEBVTT', ''];
  for (const c of cues) {
    const s = c.start + offsetMs; const e = c.end + offsetMs;
    if (e <= 0) continue;
    out.push(`${fmtTs(s)} --> ${fmtTs(e)}`, c.text, '');
  }
  return out.join('\n');
}

/** WebVTT text -> SRT (DLNA renderers such as LG TVs only take .srt). */
export function vttToSrt(vtt: string, offsetMs = 0): string {
  const cues = parseVtt(vtt);
  const ts = (ms: number) => fmtTs(ms).replace('.', ',');
  const out: string[] = []; let n = 0;
  for (const c of cues) { const s = c.start + offsetMs, e = c.end + offsetMs; if (e <= 0) continue; out.push(String(++n), `${ts(Math.max(0, s))} --> ${ts(e)}`, c.text.replace(/<[^>]+>/g, ''), ''); }
  return out.join('\r\n');
}

/** Any SRT/VTT text -> WebVTT with optional time offset. */
export function convert(text: string, offsetMs = 0): string {
  const cues = /^﻿?WEBVTT/.test(text) ? parseVtt(text) : parseSrt(text);
  return toVtt(cues, offsetMs);
}
