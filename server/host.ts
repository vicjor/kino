import net from 'node:net';
import os from 'node:os';
import type { RequestHandler } from 'express';
import { HOSTS } from './config.js';
import { logger } from './log.js';

const log = logger('host');

/**
 * The name in a Host header: lowercase, without port, trailing dot or IPv6 brackets. '' when it does not parse, and
 * for anything but hostname characters: `evil.example/x.local` must not pass as a .local name.
 */
export function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) { const m = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(h); return m && net.isIPv6(m[1]!) ? m[1]! : ''; }
  if (net.isIPv6(h)) return h;
  const m = /^([a-z0-9._-]*)(?::\d{1,5})?$/.exec(h);
  return m ? m[1]!.replace(/\.$/, '') : '';
}

/** KINO_HOSTS: more names Kino answers to, comma-separated. A leading dot also allows every name under it. */
export const envHosts = (v = HOSTS): string[] => (v || '').split(',').map(hostName).filter(Boolean);

/**
 * A Host this Kino answers to. DNS rebinding points a name the attacker owns at this Mac, so a page on it is
 * same-origin with Kino, and csrf.ts (Origin against Host) and Sec-Fetch-Site both wave it through. The browser
 * still sends that name as Host, and nobody can rebind an IP literal, localhost, a .local name (mDNS, LAN only),
 * a tailnet name or this Mac's own name. No Host at all is an HTTP/1.0 client, never a browser.
 */
export function hostAllowed(host: string | undefined, extra: readonly string[] = []): boolean {
  if (!host?.trim()) return true;
  const name = hostName(host);
  if (!name) return false;
  if (net.isIP(name) || name === 'localhost' || name.endsWith('.local') || name.endsWith('.ts.net')) return true;
  const me = hostName(os.hostname()), short = me.split('.')[0];
  if (name === me || name === short) return true;
  return extra.some((x) => (x.startsWith('.') ? name.endsWith(x) || name === x.slice(1) : name === x));
}

export const UNKNOWN_HOST = 'Unknown host name. Open Kino by its address or kino.local, or add the name to KINO_HOSTS.';

/**
 * Where the plain port (80) sends a browser: the same name on Kino's port, or null for a Host this Kino does not
 * answer to (421), so it never points anywhere else. No Host (HTTP/1.0) gets `fallback`, the LAN address. Only a
 * plain path is kept: an absolute-form or non-ASCII request target becomes `/`.
 */
export function plainRedirect(host: string | undefined, url: string | undefined, port: number, fallback: string, extra: readonly string[] = []): string | null {
  if (!hostAllowed(host, extra)) return null;
  const name = host?.trim() ? hostName(host) : fallback;
  const path = url && /^\/[\x21-\x7e]*$/.test(url) ? url : '/';
  return `http://${net.isIPv6(name) ? `[${name}]` : name}:${port}${path}`;
}

/** 421 for any other Host, on every route. One log line a minute at most: a rebinding page retries in a loop. */
export function hostGuard(extra: readonly string[] = envHosts(), now = Date.now): RequestHandler {
  let quietUntil = 0, more = 0;
  return (req, res, next) => {
    const host = req.headers.host;
    if (hostAllowed(host, extra)) { next(); return; }
    const t = now();
    if (t >= quietUntil) { log.warn('unknown host refused, add it to KINO_HOSTS if it is yours', { host: String(host).slice(0, 100), path: req.path.slice(0, 100), ip: req.socket.remoteAddress, ...(more ? { alsoRefused: more } : {}) }); quietUntil = t + 60_000; more = 0; }
    else more++;
    res.status(421).json({ error: UNKNOWN_HOST });
  };
}
