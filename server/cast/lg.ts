import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { writeAtomic } from '../store.js';
import { logger, errMsg } from '../log.js';
import { httpError } from '../errors.js';

/*
 * LG webOS's own remote protocol (SSAP), just enough to turn the TV off: DLNA can play, pause and set the volume but
 * has no power. A secure websocket on port 3001 (the TV's certificate is self-signed), a registration the TV asks you
 * to allow once (the key it hands back is kept in lg-keys.json, 0600), then one request. Turning on is Wake-on-LAN,
 * in dlna.ts. Spoken by hand over tls so Kino needs no websocket library: text frames, ping and close are all it takes.
 */
const log = logger('cast.lg');
const PORT = 3001;
const KEYS = () => path.join(DATA_DIR, 'lg-keys.json');
/** What Kino asks for: power, and the small toast that says what it did. */
const PERMISSIONS = ['CONTROL_POWER', 'READ_POWER_STATE', 'WRITE_NOTIFICATION_TOAST'];

/** One client frame: FIN, the opcode, the length in its three sizes, masked as a client must. */
export function encodeFrame(data: string | Buffer, opcode = 1, mask: Buffer = crypto.randomBytes(4)): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data) : data;
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

/** The whole frames at the front of `buf` (a server's are unmasked, but a masked one is read too) and what is left. */
export function decodeFrames(buf: Buffer): { frames: { opcode: number; data: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; data: Buffer }[] = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const opcode = buf[at] & 0x0f; const masked = (buf[at + 1] & 0x80) !== 0;
    let n = buf[at + 1] & 0x7f; let p = at + 2;
    if (n === 126) { if (buf.length - p < 2) break; n = buf.readUInt16BE(p); p += 2; }
    else if (n === 127) { if (buf.length - p < 8) break; n = Number(buf.readBigUInt64BE(p)); p += 8; }
    const mask = masked ? buf.subarray(p, p + 4) : null; if (masked) p += 4;
    if (buf.length - p < n) break;
    const data = Buffer.from(buf.subarray(p, p + n));
    if (mask) for (let i = 0; i < n; i++) data[i] ^= mask[i & 3];
    frames.push({ opcode, data });
    at = p + n;
  }
  return { frames, rest: buf.subarray(at) };
}

/** The registration: with the key from last time the TV says yes at once, without one it asks on screen. */
export function registration(key?: string): object {
  return { type: 'register', id: 'register_0', payload: { forcePairing: false, pairingType: 'PROMPT', ...(key ? { 'client-key': key } : {}), manifest: { manifestVersion: 1, appVersion: '1.1', permissions: PERMISSIONS } } };
}

function readKeys(): Record<string, string> {
  try { const k = JSON.parse(fs.readFileSync(KEYS(), 'utf8')) as unknown; return k && typeof k === 'object' ? k as Record<string, string> : {}; } catch { return {}; }
}
function saveKey(id: string, key: string): void {
  try { writeAtomic(KEYS(), JSON.stringify({ ...readKeys(), [id]: key }, null, 2)); } catch (e) { log.warn('could not keep the TV key', { err: errMsg(e) }); }
}

export const io = { connect: (host: string) => tls.connect({ host, port: PORT, rejectUnauthorized: false }) };

/**
 * Register with the TV at `host` (Kino's renderer id `id` names the key) and send one request. Resolves with the TV's
 * answer. Waits up to a minute when the TV is asking you to allow Kino, ten seconds otherwise.
 */
export function ssap(host: string, id: string, uri: string, payload?: object): Promise<unknown> {
  const key = readKeys()[id];
  return new Promise((resolve, reject) => {
    const s = io.connect(host);
    let buf: Buffer = Buffer.alloc(0); let open = false; let settled = false;
    const done = (err: Error | null, v?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { s.write(encodeFrame(Buffer.alloc(0), 8)); } catch { /* gone */ }
      s.destroy();
      if (err) reject(err); else resolve(v);
    };
    let timer = setTimeout(() => done(httpError(504, 'The TV did not answer')), 10_000);
    const send = (m: object) => s.write(encodeFrame(JSON.stringify(m)));
    s.on('secureConnect', () => {
      s.write(`GET / HTTP/1.1\r\nHost: ${host}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, end).toString())) { done(httpError(502, 'The TV refused the connection')); return; }
        open = true; buf = buf.subarray(end + 4);
        send(registration(key));
      }
      const { frames, rest } = decodeFrames(buf); buf = rest;
      for (const f of frames) {
        if (f.opcode === 9) { s.write(encodeFrame(f.data, 10)); continue; }
        if (f.opcode === 8) { done(httpError(502, 'The TV closed the connection')); return; }
        if (f.opcode !== 1) continue;
        let m: { type?: string; id?: string; error?: string; payload?: Record<string, unknown> };
        try { m = JSON.parse(f.data.toString()); } catch { continue; }
        if (m.id === 'register_0') {
          if (m.type === 'response' && m.payload?.pairingType === 'PROMPT') {
            // Asking on the TV now: give whoever is on the sofa a minute to press Allow.
            log.info('asking on the TV to allow Kino', { host });
            clearTimeout(timer); timer = setTimeout(() => done(httpError(504, 'Nobody allowed Kino on the TV in time. Try again and press Allow on the TV.')), 60_000);
          } else if (m.type === 'registered') {
            const k = m.payload?.['client-key'];
            if (typeof k === 'string' && k !== key) saveKey(id, k);
            send({ type: 'request', id: 'req_1', uri, ...(payload ? { payload } : {}) });
          } else if (m.type === 'error') done(httpError(403, 'The TV did not allow Kino. Try again and press Allow on the TV.'));
        } else if (m.id === 'req_1') {
          if (m.type === 'error' || m.payload?.returnValue === false) done(httpError(502, `The TV said no: ${m.error || 'refused'}`));
          else done(null, m.payload);
        }
      }
    });
    s.on('error', (e) => done(httpError(502, `Could not reach the TV: ${e.message}`)));
    s.on('close', () => done(httpError(502, 'The TV hung up')));
  });
}

export const turnOff = (host: string, id: string): Promise<unknown> => ssap(host, id, 'ssap://system/turnOff');

/** An LG TV by what it says it is: those speak SSAP beside DLNA. */
export const isLg = (r: { name?: string; model?: string }): boolean => /\bLG\b|webOS/i.test(`${r.name || ''} ${r.model || ''}`);
