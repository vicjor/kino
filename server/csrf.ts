import type { IncomingHttpHeaders } from 'node:http';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) || '';
/** host[:port], lowercase, default port dropped: "Kino.local:80" and "kino.local" are the same host. */
const norm = (h: string): string => h.trim().toLowerCase().replace(/:(80|443)$/, '');

/**
 * A write that a page on some other site made the browser send (any tab on any LAN or tailnet device
 * could otherwise change settings, restore a backup or clear the cache). Browsers say so in
 * Sec-Fetch-Site; older ones only send an Origin, compared with the Host the request came in on or the
 * X-Forwarded-Host that tailscale serve adds. No Origin at all is curl, Home Assistant or a Shortcut: it passes.
 */
export function isCrossSiteWrite(method: string, headers: IncomingHttpHeaders): boolean {
  if (SAFE.has(method.toUpperCase())) return false;
  const site = one(headers['sec-fetch-site']).trim().toLowerCase();
  if (site === 'cross-site') return true;
  if (site === 'same-origin' || site === 'none') return false;
  // same-site (another port on this Mac) or an older browser: the Origin decides
  const origin = one(headers.origin).trim();
  if (!origin) return false;
  let from: string;
  try { from = norm(new URL(origin).host); } catch { return true; }   // "null": a sandboxed frame or a file
  if (!from) return true;
  const ours = [one(headers.host), ...one(headers['x-forwarded-host']).split(',')].map(norm).filter(Boolean);
  return !ours.includes(from);
}
