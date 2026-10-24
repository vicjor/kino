import { logger } from './log.js';
import { guardedGet, NO_ANSWER, type Guarded, type GuardOpts } from './net-guard.js';
const log = logger('fetch');

/** A URL fit for logs and error text: key-like query values (api_key, apikey, token, key) and any password are masked. */
export function redact(url: string): string {
  return url
    .replace(/([?&;](?:api[_-]?key|access[_-]?token|token|key)=)[^&#;\s]*/gi, '$1***')
    .replace(/(\/\/[^/?#@\s:]*:)[^/?#@\s]*@/, '$1***@');
}

/** Largest JSON body fetchJson reads by default. The biggest real ones (a long series' meta, the addon collection) are under 2 MB. */
export const JSON_MAX_BYTES = 10 * 1024 * 1024;

/** An address Kino did not pick itself (an addon's, or one an addon named) goes through net-guard: see guardedGet. */
type Guard = Pick<GuardOpts, 'allowPrivate' | 'what'>;

/**
 * An upstream that answered with an error status: `upstreamStatus` is that status, for code to read (a 404 from
 * Cinemeta is a title it does not know). Its text (the status and the redacted URL) is for the log: the error names no
 * status of its own, so a request that fails on it answers the generic sentence.
 */
type UpstreamError = Error & { upstreamStatus: number };
const upstreamError = (status: number, statusText: string, url: string): UpstreamError =>
  Object.assign(new Error(`${status} ${statusText} for ${redact(url)}`), { upstreamStatus: status });
/** The status an upstream answered with, when a fetch here failed on one. */
export function upstreamStatusOf(e: unknown): number | undefined {
  const s = (e && typeof e === 'object' ? e : {}) as { upstreamStatus?: unknown };
  return typeof s.upstreamStatus === 'number' ? s.upstreamStatus : undefined;
}

/**
 * JSON over fetch, at most maxBytes (default JSON_MAX_BYTES), checked while streaming. With `guard`, a guardedGet
 * instead (a GET with init's headers, nothing else from init): private targets per the guard, redirects checked by hand.
 */
export async function fetchJson<T = unknown>(url: string, timeoutMs = 10_000, init: RequestInit & { maxBytes?: number; guard?: Guard } = {}): Promise<T> {
  const { maxBytes = JSON_MAX_BYTES, guard, ...rest } = init;
  let buf: Buffer;
  if (guard) {
    const headers = { 'user-agent': 'kino/0.1', accept: 'application/json', ...Object.fromEntries(new Headers(rest.headers ?? {})) };
    buf = (await guardedBody(url, timeoutMs, guard, headers, maxBytes, { status: (r) => upstreamError(r.status, r.statusText, url), big: () => tooBig(maxBytes, url) })).buf;
  } else {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'kino/0.1', accept: 'application/json', ...(rest.headers || {}) } });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw upstreamError(res.status, res.statusText, url); }
    buf = await readCapped(res, maxBytes, url);
  }
  // TextDecoder drops a leading BOM, as res.json() did
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

const httpErr = (msg: string, status: number) => Object.assign(new Error(msg), { status });
const tooBig = (maxBytes: number, url: string) => httpErr(`Response over ${maxBytes} bytes for ${redact(url)}`, 502);

/** The body, refused once it passes maxBytes (checked while streaming, so a huge or endless body never sits in memory). */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel().catch(() => {}); throw tooBig(maxBytes, url); }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(); const chunks: Buffer[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) { await reader.cancel().catch(() => {}); throw tooBig(maxBytes, url); }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, n);
}

/**
 * A GET through net-guard, its body read whole under the same cap; an answer other than 2xx throws fail.status, a body
 * over the cap fail.big. A body that stalls past the timeout counts as no answer (code NO_ANSWER), as guardedGet's own timeouts do.
 */
async function guardedBody(url: string, timeoutMs: number, guard: Guard, headers: Record<string, string>, maxBytes: number, fail: { status: (r: Guarded) => Error; big: () => Error }): Promise<{ r: Guarded; buf: Buffer }> {
  const signal = AbortSignal.timeout(timeoutMs);
  const r = await guardedGet(url, { ...guard, signal, headers });
  if (!r.ok) { r.body.destroy(); throw fail.status(r); }
  if (Number(r.headers['content-length']) > maxBytes) { r.body.destroy(); throw fail.big(); }
  const chunks: Buffer[] = []; let n = 0;
  try {
    for await (const c of r.body as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > maxBytes) throw fail.big();   // leaving the loop destroys the stream
      chunks.push(c);
    }
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    throw Object.assign(new Error(signal.aborted ? `The ${guard.what} did not answer in time` : `The ${guard.what} stopped halfway through`), { status: 502, ...(signal.aborted && { code: NO_ANSWER }) });
  }
  return { r, buf: Buffer.concat(chunks, n) };
}

/** A size for people: whole megabytes when it is some, else bytes. */
const sizeText = (n: number) => (n >= 1024 * 1024 && n % (1024 * 1024) === 0 ? `${n / 1024 / 1024} MB` : `${n} bytes`);

/**
 * A text file over http(s) only, at most maxBytes (default 16 MB), through net-guard: a private target only with
 * allowPrivate, redirects checked by hand. `what` names the file in errors ("That subtitle points at ...").
 * An error status or a body over the cap is a 502 that names neither the URL nor its tokens; the log has the redacted URL.
 */
export async function fetchText(url: string, timeoutMs = 15_000, opts: { maxBytes?: number; allowPrivate?: boolean; what?: string } = {}): Promise<{ text: string; buf: Buffer; contentType: string }> {
  let proto = ''; try { proto = new URL(url).protocol; } catch { /* not a URL */ }
  if (proto !== 'http:' && proto !== 'https:') throw httpErr(`Refusing to fetch a ${proto || 'malformed'} address, only http and https`, 400);
  const guard = { allowPrivate: opts.allowPrivate ?? false, what: opts.what ?? 'file' };
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const fail = {
    status: (r: Guarded) => {
      log.warn('download failed', { what: guard.what, url: redact(url), status: r.status, statusText: r.statusText });
      return Object.assign(httpErr(`The ${guard.what} could not be downloaded (its server answered ${r.status})`, 502), { upstreamStatus: r.status });
    },
    big: () => { log.warn('download too large', { what: guard.what, url: redact(url), maxBytes }); return httpErr(`The ${guard.what} is over ${sizeText(maxBytes)}, too large to use`, 502); },
  };
  const { r, buf } = await guardedBody(url, timeoutMs, guard, { 'user-agent': 'kino/0.1' }, maxBytes, fail);
  return { text: buf.toString('utf8'), buf, contentType: String(r.headers['content-type'] || '') };
}

interface TtlCacheOpts<V> {
  /** Serve a value this long (ms) past its ttl while one background call refreshes it. Default 0: dropped at ttl. */
  stale?: number;
  /** After a stale refresh fails or gives an invalid value, wait this long (ms) before trying again. Default one minute. */
  retry?: number;
  /** Whether an upstream answer is worth caching, e.g. `(v) => !!v?.meta`. One it refuses is never cached, so it never replaces a good value. Default: any. */
  valid?: (v: V) => boolean;
}

/**
 * Tiny TTL cache for upstream JSON. With `stale` (ms), a value past its ttl is still served for that much longer
 * while one background call refreshes it; a failed or invalid refresh keeps the old value and waits `retry` before the next.
 */
export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number; retryAt?: number }>();
  private inflight = new Map<string, Promise<V>>();
  private staleMs: number;
  private retryMs: number;
  private valid: (v: V) => boolean;
  constructor(private ttlMs: number, private max = 500, opts: TtlCacheOpts<V> = {}) {
    this.staleMs = opts.stale ?? 0; this.retryMs = opts.retry ?? 60_000; this.valid = opts.valid ?? (() => true);
  }
  /** The entry while it may be served (fresh or stale); dropped once past ttl plus stale. */
  private entry(k: string) {
    const e = this.m.get(k);
    if (e && e.exp + this.staleMs < Date.now()) { this.m.delete(k); return undefined; }
    return e;
  }
  /** The cached value, fresh or stale. Never fetches. */
  get(k: string): V | undefined { return this.entry(k)?.v; }
  set(k: string, v: V): V {
    if (!this.m.delete(k) && this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { v, exp: Date.now() + this.ttlMs });
    return v;
  }
  /**
   * Cached value, or fn's. Concurrent misses for one key share a single fn call; a failure is not cached, nor is a
   * value `valid` refuses (the caller still gets it). A stale value comes back at once and one fn call refreshes it.
   */
  wrap(k: string, fn: () => Promise<V>): Promise<V> {
    const e = this.entry(k);
    if (!e) return this.load(k, fn);
    const now = Date.now();
    if (e.exp < now && !(e.retryAt != null && e.retryAt > now) && !this.inflight.has(k)) {
      // Upstream down or answering empty: keep serving the old value and leave upstream alone for a while.
      const backOff = () => { if (this.m.get(k) === e) e.retryAt = Date.now() + this.retryMs; };
      this.load(k, fn).then((v) => { if (!this.valid(v)) { log.debug('cache refresh refused', { k: redact(k) }); backOff(); } }, backOff);
    }
    return Promise.resolve(e.v);
  }
  private load(k: string, fn: () => Promise<V>): Promise<V> {
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p: Promise<V> = Promise.resolve().then(fn)
      .then((v) => (this.valid(v) ? this.set(k, v) : v), (e) => { log.debug('cache miss failed', { k: redact(k), err: String(e) }); throw e; })
      .finally(() => { if (this.inflight.get(k) === p) this.inflight.delete(k); });
    this.inflight.set(k, p);
    return p;
  }
}
