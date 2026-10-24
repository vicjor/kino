import type { Request, Response } from 'express';
import type { Torrent } from 'webtorrent';
import { PORT } from '../config.js';
import { openFile, closeFile, type Reader } from '../torrent.js';
import { logger } from '../log.js';

const log = logger('range');

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  srt: 'text/plain', vtt: 'text/vtt', mp3: 'audio/mpeg', aac: 'audio/aac', flac: 'audio/flac',
};
export function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return MIME[ext] || 'application/octet-stream';
}

/** This server's own range URL for a torrent file: what ffprobe, ffmpeg and subtitle extraction read through. */
export const localFileUrl = (infoHash: string, idx: number): string => `http://127.0.0.1:${PORT}/api/file/${infoHash}/${idx}`;

/** `?src=hls` on a file URL: an HLS transcoder's ffmpeg reads it (hls.ts tags its -i). /health counts that read as the session, not a viewer. */
export const TRANSCODER_SRC = 'hls';
const readerOf = (req: Request): Reader => (req.query.src === TRANSCODER_SRC ? 'transcoder' : 'viewer');

/** What to answer a Range header with: the whole file, one byte range, or 416 (nothing asked for is in the file). */
export type RangeAnswer = { status: 200 } | { status: 206; start: number; end: number } | { status: 416 };

/**
 * The bytes to serve for a Range header over a file of `size` bytes (RFC 9110 section 14).
 * - An end at or past the size is clamped to the last byte: some DLNA renderers ask for bytes=0-<huge>.
 * - A suffix range (bytes=-500) is the last 500 bytes, the whole file when it is shorter.
 * - 416 when nothing asked for is in the file (start at or past the size, a zero suffix) and when the header is
 *   malformed (no unit, a spec that is not first-last, a start after its end).
 * - No header, or a unit other than bytes, gets the whole file (200): the RFC says ignore a unit you do not know.
 * - Several ranges: the first one that is in the file, as a plain 206 with its own Content-Range. No multipart
 *   body; a client reads which bytes it got from Content-Range, and media clients ask for one range anyway.
 */
export function parseRange(header: string | undefined, size: number): RangeAnswer {
  if (header === undefined) return { status: 200 };
  const m = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(.*)$/.exec(header);
  if (!m) return { status: 416 };
  if (m[1].toLowerCase() !== 'bytes') return { status: 200 };
  const specs = m[2].split(',').map((x) => x.trim()).filter(Boolean);
  if (!specs.length) return { status: 416 };
  let hit: { start: number; end: number } | undefined;
  for (const spec of specs) {
    const r = /^(\d*)-(\d*)$/.exec(spec);
    if (!r || (!r[1] && !r[2])) return { status: 416 };
    if (r[1]) {
      const start = Number(r[1]); const last = r[2] ? Number(r[2]) : Infinity;
      if (start > last) return { status: 416 };
      if (!hit && start < size) hit = { start, end: Math.min(last, size - 1) };
    } else {
      const n = Number(r[2]);
      if (!hit && n > 0 && size > 0) hit = { start: Math.max(0, size - n), end: size - 1 };
    }
  }
  return hit ? { status: 206, ...hit } : { status: 416 };
}

/** HTTP range server over a torrent file. Used by browsers, Chromecast, DLNA TVs and ffmpeg. */
export function serveFile(req: Request, res: Response, t: Torrent, idx: number): void {
  const f = t.files[idx];
  if (!f) { res.status(404).json({ error: 'file not found' }); return; }
  const size = f.length;
  const mime = mimeFor(f.name);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);

  const r = parseRange(req.headers.range, size);
  if (r.status === 416) { res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; }
  const start = r.status === 206 ? r.start : 0;
  const end = r.status === 206 ? r.end : size - 1;
  res.status(r.status);
  if (r.status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD' || end < start) { res.end(); return; }   // end < start: an empty file, nothing to stream

  const reader = readerOf(req);
  openFile(t, idx, reader);
  const stream = f.createReadStream({ start, end });
  let closed = false;
  const done = () => { if (closed) return; closed = true; stream.destroy(); closeFile(t, idx, reader); };
  res.on('close', done);
  res.on('finish', done);
  stream.on('error', (e) => { log.warn('stream error', { err: e.message }); done(); if (!res.headersSent) res.status(500); res.end(); });
  stream.pipe(res);
}
