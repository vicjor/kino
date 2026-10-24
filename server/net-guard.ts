import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { pipeline, type Readable, type Transform } from 'node:stream';

/**
 * Outbound GETs to addresses a third party picked: a playlist's segments, a subtitle addon's file URL, an addon's
 * redirect. Private, loopback and link-local targets are refused unless the caller vouches for them, checked on the
 * address actually connected to, and redirects are followed by hand so every hop is checked the same way. A host a LAN
 * check vouched for is connected to at the addresses that check saw, never looked up again (DNS rebinding).
 */

/**
 * Where a third party must not send Kino: this Mac, the LAN, the tailnet (CGNAT), link-local (router and cloud metadata),
 * multicast and reserved space. IPv4 ranges also count inside NAT64, IPv4-compatible and 6to4 addresses; BlockList
 * matches IPv4-mapped ones (::ffff:a.b.c.d) against the IPv4 rules by itself.
 */
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  const [w, x, y, z] = a.split('.').map(Number);
  PRIVATE.addSubnet(a, p, 'ipv4');
  PRIVATE.addSubnet(`64:ff9b::${a}`, 96 + p, 'ipv6');
  PRIVATE.addSubnet(`::${a}`, 96 + p, 'ipv6');
  PRIVATE.addSubnet(`2002:${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}::`, 16 + p, 'ipv6');
}
for (const [a, p] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b:1::', 48]] as const) PRIVATE.addSubnet(a, p, 'ipv6');

/** An address on a private, loopback, link-local or reserved network. Anything that is no IP address counts too. */
export function privateAddress(ip: string): boolean {
  const a = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = net.isIP(a);
  return v === 0 || PRIVATE.check(a, v === 6 ? 'ipv6' : 'ipv4');
}

/** Names no public registry hands out: localhost, mDNS .local, home.arpa, .internal, .lan, and a bare label (a LAN search domain). */
export function localName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !!h && net.isIP(h) === 0 && (!h.includes('.') || /(^|\.)(localhost|local|home\.arpa|internal|lan)$/.test(h));
}

/** DNS and the address rule as an object, so a test can point names at its own servers and say what counts as private. */
export const io = {
  lookup: (host: string): Promise<dns.LookupAddress[]> => dns.promises.lookup(host, { all: true }),
  isPrivate: privateAddress,
};

/** Error codes: a target refused as private (or not http), and no answer at all (timeout, DNS, socket). */
export const REFUSED = 'KINO_PRIVATE_ADDRESS';
export const NO_ANSWER = 'KINO_NO_ANSWER';
const refused = (host: string, msg: string) => Object.assign(new Error(msg), { status: 403, code: REFUSED, host });

/** Every address of the URL's host: an IP literal as it is, a name by DNS. A failed lookup throws. */
async function addressesOf(url: string): Promise<dns.LookupAddress[]> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const v = net.isIP(host);
  return v ? [{ address: host, family: v }] : io.lookup(host);
}

/**
 * What a LAN check of an address found. `addresses`: the answers that made the host count as LAN (none for a local-only
 * name). A guarded GET to `host` under this check connects to those and asks DNS nothing, so a name cannot answer
 * private for the check and public for the connection.
 */
export interface LanCheck { host: string; lan: boolean; addresses?: dns.LookupAddress[] }

/**
 * Whether an address the owner configured is on the home network: a local-only name, or a host whose every address is
 * private. A name with one public address is not, unless it is a local-only name (a NAS on .local often has a global
 * IPv6 too). A failed lookup or a bad URL is no.
 */
export async function checkLan(url: string): Promise<LanCheck> {
  let host = '';
  try {
    host = new URL(url).hostname;
    if (localName(host)) return { host, lan: true };
    const all = await addressesOf(url);
    return all.length > 0 && all.every((a) => io.isPrivate(a.address)) ? { host, lan: true, addresses: all } : { host, lan: false };
  } catch { return { host, lan: false }; }
}

/** checkLan's answer alone, for a caller that makes no request under it. */
export const onLan = async (url: string): Promise<boolean> => (await checkLan(url)).lan;

/** Hand `found` to a socket's lookup: only the family it asked for, every address or the first. */
function reply(host: string, found: dns.LookupAddress[], opts: dns.LookupOptions, cb: Parameters<net.LookupFunction>[2]): void {
  const fam = opts.family === 4 || opts.family === 'IPv4' ? 4 : opts.family === 6 || opts.family === 'IPv6' ? 6 : 0;
  const list = fam ? found.filter((a) => a.family === fam) : found;
  if (!list.length) cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), '');
  else if (opts.all) cb(null, list);
  else cb(null, list[0].address, list[0].family);
}

/**
 * Resolve a name for a connection, refusing it when any address is private (unless allowed). It runs as the socket's
 * own lookup, so the address checked is the address connected to. With `pinned`, the addresses a LAN check saw answer
 * instead and DNS is not asked again.
 */
const lookupFor = (allowPrivate: boolean, what: string, pinned?: dns.LookupAddress[]): net.LookupFunction => (host, opts, cb) => {
  if (pinned) { reply(host, pinned, opts, cb); return; }
  io.lookup(host).then((found) => {
    if (!allowPrivate && found.some((a) => io.isPrivate(a.address))) throw refused(host, `That ${what} points at a private network address`);
    return found;
  }).then((found) => reply(host, found, opts, cb), (e: NodeJS.ErrnoException) => cb(e, ''));
};

// Keep-alive pools apart by rule, so a socket opened where private targets were allowed is never reused where they are
// not, and one to a pinned host only ever holds an address a LAN check of that host saw.
const pool = () => ({ http: new http.Agent({ keepAlive: true, timeout: 5000 }), https: new https.Agent({ keepAlive: true, timeout: 5000 }) });
const POOLS = { open: pool(), guarded: pool(), pinned: pool() };

/**
 * One GET, no redirects followed. An IP literal skips the socket's lookup, so it is checked here. `pinned`: connect to
 * these addresses; the URL still names the host, so the Host header and the TLS server name stay the host's.
 */
function get1(at: URL, headers: Record<string, string>, allowPrivate: boolean, what: string, signal: AbortSignal, pinned?: dns.LookupAddress[]): Promise<http.IncomingMessage> {
  if (at.protocol !== 'http:' && at.protocol !== 'https:') return Promise.reject(refused(at.protocol, `That ${what} is not on http or https`));
  const literal = at.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(literal) && io.isPrivate(literal)) return Promise.reject(refused(literal, `That ${what} points at a private network address`));
  const tls = at.protocol === 'https:'; const pool = pinned ? POOLS.pinned : allowPrivate ? POOLS.open : POOLS.guarded;
  return new Promise((resolve, reject) => {
    const req = (tls ? https : http).request(at, { headers, signal, agent: tls ? pool.https : pool.http, lookup: lookupFor(allowPrivate, what, pinned) }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** The encodings guardedGet asks for, whatever the caller asked for: it undoes these, and only these. */
const ENCODINGS = 'gzip, deflate, br';
/** Undo gzip, deflate or brotli as fetch does, forgiving a truncated end. */
function decoder(enc: string | undefined): Transform | undefined {
  const sync = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch ((enc || '').trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.createGunzip(sync);
    case 'deflate': return zlib.createInflate(sync);
    case 'br': return zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    default: return undefined;
  }
}

/** p, or the signal's reason once it aborts first. */
function whileOpen<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** What guardedGet hands back: where the redirects ended, and the body already decoded (no content-length then). */
export interface Guarded { status: number; statusText: string; ok: boolean; url: string; headers: http.IncomingHttpHeaders; body: Readable }
/** Redirects followed per request. */
export const MAX_HOPS = 5;

export interface GuardOpts {
  /**
   * Whether private, loopback and link-local targets are fine: true when the caller vouches for them, 'own-lan' when
   * the first URL is itself on the LAN (an address the owner configured, see checkLan), or a LanCheck of the first URL's
   * host made up front. Under a check that found the LAN by address, every hop to that host connects to the addresses
   * it saw. A check of another host counts as no.
   */
  allowPrivate: boolean | 'own-lan' | LanCheck;
  /** Names the thing in error text: "Could not reach the stream". */
  what: string;
  signal: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * GET a URL a third party picked. Private targets are refused (403, code REFUSED) unless allowed, as is any scheme but
 * http and https. Redirects are followed by hand, at most MAX_HOPS (then a 502), each hop checked the same way;
 * credentials stay behind when one leaves the origin. No answer (timeout, DNS, socket) is a 502 with code NO_ANSWER,
 * in words that name no host; the host and the low-level reason ride along for the log.
 */
export async function guardedGet(url: string, o: GuardOpts): Promise<Guarded> {
  let headers: Record<string, string> = { ...o.headers, 'accept-encoding': ENCODINGS };
  let at = new URL(url);
  try {
    const v = o.allowPrivate === 'own-lan' ? await whileOpen(checkLan(url), o.signal) : o.allowPrivate;
    const allowPrivate = typeof v === 'object' ? v.lan && v.host === at.hostname : v;
    const pin = typeof v === 'object' && allowPrivate ? v : undefined;
    for (let hop = 0; ; hop++) {
      const msg = await get1(at, headers, allowPrivate, o.what, o.signal, pin?.host === at.hostname ? pin.addresses : undefined);
      const status = msg.statusCode ?? 0; const loc = msg.headers.location;
      if (![301, 302, 303, 307, 308].includes(status) || !loc) {
        const h = { ...msg.headers }; const dec = decoder(h['content-encoding']);
        if (dec) { delete h['content-encoding']; delete h['content-length']; }
        return { status, statusText: msg.statusMessage || '', ok: status >= 200 && status < 300, url: at.toString(), headers: h, body: dec ? pipeline(msg, dec, () => {}) : msg };
      }
      msg.destroy();
      if (hop >= MAX_HOPS) throw Object.assign(new Error(`The ${o.what} redirected too many times`), { status: 502 });
      const next = new URL(loc, at);
      if (next.origin !== at.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|proxy-authorization|cookie)$/i.test(k)));
      at = next;
    }
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    // Socket and DNS errors name the host or its address; the caller hears only that nothing answered.
    const reason = (e as { code?: string }).code || (e as Error).name;
    throw Object.assign(new Error(o.signal.aborted ? `The ${o.what} did not answer in time` : `Could not reach the ${o.what}`), { status: 502, code: NO_ANSWER, host: at.host, reason });
  }
}
