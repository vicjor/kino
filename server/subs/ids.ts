import fs from 'node:fs';
import crypto from 'node:crypto';
import { SECRET_FILE } from '../config.js';
import { logger, errMsg } from '../log.js';
import { httpError } from '../errors.js';

const log = logger('subs');

/**
 * Subtitle track ids travel to the client and come back in /api/subs/file/:id.vtt. The id says where the
 * subtitle lives (a remote URL, a file in a torrent, a stream in the video), so an id Kino did not issue
 * must never be resolved: that would let any LAN device or web page make Kino fetch any URL.
 * Format: `<base64url JSON>.<base64url HMAC-SHA256, 16 bytes>`. Ids from before signing have no tag.
 * `lan: 1` on a remote one: the addon that named the URL is itself on the LAN, so the URL may be too (net-guard).
 */
export type SubKey = { o: 'os'; u: string; e?: string; lan?: 1 } | { o: 't'; h: string; i: number } | { o: 'e'; h: string; i: number; s: number };

const TAG_BYTES = 16;

/**
 * The random key in DATA_DIR/secret.key (0600), created on first use so importing this module writes nothing.
 * Anything else that signs with it should derive its own subkey, as subsKey does.
 */
const keys = new Map<string, Buffer>();
export function secretKey(file = SECRET_FILE): Buffer {
  const have = keys.get(file); if (have) return have;
  let k: Buffer | undefined;
  try {
    const read = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (read.length >= 32) { k = read; if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); }
  } catch { /* missing: create it */ }
  if (!k) {
    k = crypto.randomBytes(32);
    try { fs.writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600); }
    catch (e) { log.warn('could not save the secret key, subtitle ids last until restart', { err: errMsg(e) }); }
  }
  keys.set(file, k);
  return k;
}
const subsKey = (root: Buffer) => crypto.createHmac('sha256', root).update('kino:subs:id').digest();
const tagOf = (payload: string, root: Buffer) => crypto.createHmac('sha256', subsKey(root)).update(payload).digest().subarray(0, TAG_BYTES);

/** The part of an id that names the subtitle, tag or not. The disk cache is keyed on it, so signed and legacy ids share files. */
export const payloadOf = (id: string): string => id.split('.')[0];

export function encodeSubId(k: SubKey, root = secretKey()): string {
  const payload = Buffer.from(JSON.stringify(k)).toString('base64url');
  return `${payload}.${tagOf(payload, root).toString('base64url')}`;
}

function isKey(k: unknown): k is SubKey {
  if (!k || typeof k !== 'object') return false;
  const x = k as Record<string, unknown>;
  if (x.o === 'os') return typeof x.u === 'string';
  if (x.o === 't') return typeof x.h === 'string' && Number.isInteger(x.i);
  if (x.o === 'e') return typeof x.h === 'string' && Number.isInteger(x.i) && Number.isInteger(x.s);
  return false;
}

/**
 * The key in an id from before signing (a bare payload, no tag), or undefined. Only for re-signing ids saved
 * back then: once in the store's v2 migration, and in a restored backup (adoptSubId). Signing a bare id that came
 * in a playback request would make signing moot. Only the exact form the old encoder wrote counts, so the signed
 * id keeps its payload and its disk cache file.
 */
export function legacySubKey(id: unknown): SubKey | undefined {
  if (typeof id !== 'string' || !id || id.includes('.')) return undefined;
  let k: unknown;
  try { k = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { return undefined; }
  return isKey(k) && Buffer.from(JSON.stringify(k)).toString('base64url') === id ? k : undefined;
}

function signedWith(payload: string, tag: string | undefined, root: Buffer): boolean {
  const got = tag ? Buffer.from(tag, 'base64url') : Buffer.alloc(0);
  return got.length === TAG_BYTES && crypto.timingSafeEqual(got, tagOf(payload, root));
}

/** The key inside a signed id. An unsigned or tampered id is a 404; a signed id that holds no key is a 400. */
export function decodeSubId(id: string, root = secretKey()): SubKey {
  const [payload, tag, extra] = id.split('.');
  if (!payload || extra !== undefined || !signedWith(payload, tag, root)) throw httpError(404, 'Subtitle not found');
  let k: unknown;
  try { k = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw httpError(400, 'Bad subtitle id'); }
  if (!isKey(k)) throw httpError(400, 'Bad subtitle id');
  return k;
}

/** A tag as encodeSubId writes it: TAG_BYTES in unpadded base64url. */
const TAG_RE = /^[\w-]{22}$/;

/**
 * A saved subtitle id from a restored backup, made to match this install: kept when this key signed it, re-signed
 * when it is a bare id from before signing or was signed with another install's secret.key (a backup made on another
 * Mac), undefined for anything else. Only the exact payload the encoder writes counts, so the id keeps its disk cache
 * file. A restore may sign what it brings because it is a settings write, which already sets the addon and webhook
 * addresses Kino fetches; a playback request may not (decodeSubId).
 */
export function adoptSubId(id: unknown, root = secretKey()): string | undefined {
  if (typeof id !== 'string') return undefined;
  const [payload, tag, extra] = id.split('.');
  const k = legacySubKey(payload);
  if (!k || extra !== undefined || (tag !== undefined && !TAG_RE.test(tag))) return undefined;
  return tag !== undefined && signedWith(payload, tag, root) ? id : encodeSubId(k, root);
}
