import crypto from 'node:crypto';
import net from 'node:net';

/**
 * The kino_auth cookie value for a PIN: an HMAC of the PIN under a key derived for this purpose from the
 * install's random secret (DATA_DIR/secret.key, see subs/ids.ts). Nobody can compute it from the PIN alone,
 * and a new PIN or a new secret logs every browser out.
 */
export function pinToken(pin: string, root: Buffer): string {
  const key = crypto.createHmac('sha256', root).update('kino:pin:cookie').digest();
  return crypto.createHmac('sha256', key).update(pin).digest('hex');
}

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
/** String equality in constant time: both sides hashed first, so timingSafeEqual gets equal lengths and the length leaks nothing. */
export function sameSecret(a: string, b: string): boolean { return crypto.timingSafeEqual(digest(a), digest(b)); }

/** Every value a Cookie header holds for one name (a browser can send the same name twice). */
export function cookieValues(header: string | undefined, name: string): string[] {
  const out: string[] = [];
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

const LOOPBACK = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^::1$/;
/**
 * Who a PIN attempt counts against. Tailscale serve (and any proxy on this Mac) connects from loopback, so by the
 * socket alone every visitor behind it would share one failure count: there X-Forwarded-For names the visitor.
 * Only from loopback, because any LAN client can send that header. The last address is the one the proxy saw
 * itself; anything before it came from the visitor's request and could be made up.
 */
export function attemptKey(remote: string | undefined, forwardedFor: string | string[] | undefined): string {
  const addr = remote || '';
  if (!LOOPBACK.test(addr)) return addr;
  const last = [forwardedFor ?? []].flat().join(',').split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last && net.isIP(last) ? last : addr;
}

export interface AttemptLimiter {
  /** Milliseconds this caller must still wait before it may try again; 0 when it may try now. */
  wait(key: string): number;
  /** How long the pause this caller is in lasts, all of it, not what is left; 0 when it may try now. */
  pause(key: string): number;
  /** One wrong attempt. The one that reaches the limit starts the pause. */
  fail(key: string): void;
  /** A right attempt: forget this caller's failures. */
  clear(key: string): void;
  /** Callers remembered right now. */
  size(): number;
}

interface Pacing { blockMs?: number; maxBlockMs?: number; forgetMs?: number; now?: () => number }

/**
 * Wrong-PIN brake with a growing pause: every `max` failures from one caller pause it, `blockMs` the first time and
 * twice as long each time after, up to `maxBlockMs`. Failures add up however slowly they come, so staying just under a
 * rate gains nothing; they are forgotten after `forgetMs` without one, or by clear (a right PIN). The clock is
 * injected so tests can run it without waiting. A forgotten caller stays in the map until a sweep, at most once a
 * minute from 256 callers on, and acts as if it were gone: only size() sees it.
 */
export function attemptLimiter({ max = 5, blockMs = 60_000, maxBlockMs = 3_600_000, forgetMs = 86_400_000, now = Date.now }: { max?: number } & Pacing = {}): AttemptLimiter {
  type Entry = { fails: number; pauses: number; until: number; last: number; len: number };
  const seen = new Map<string, Entry>();
  const stale = (e: Entry, t: number) => t >= e.until && t - e.last >= forgetMs;
  let swept = -Infinity;
  return {
    wait(key) { const e = seen.get(key); return e ? Math.max(0, e.until - now()) : 0; },
    pause(key) { const e = seen.get(key); return e && e.until > now() ? e.len : 0; },
    fail(key) {
      const t = now();
      if (seen.size >= 256 && t - swept >= 60_000) {   // one entry per caller that failed lately; a walk of the whole map, so not on every wrong PIN
        swept = t;
        for (const [k, e] of seen) if (stale(e, t)) seen.delete(k);
      }
      if (seen.size >= 4096 && !seen.has(key)) seen.delete(seen.keys().next().value!);   // hard bound; pinAttempts' total never lets it get here
      let e = seen.get(key);
      if (!e || stale(e, t)) { e = { fails: 0, pauses: 0, until: 0, last: t, len: 0 }; seen.set(key, e); }
      e.last = t;
      if (++e.fails < max) return;
      e.fails = 0;
      e.len = Math.min(blockMs * 2 ** e.pauses++, maxBlockMs);
      e.until = t + e.len;
    },
    clear(key) { seen.delete(key); },
    size: () => seen.size,
  };
}

/**
 * The PIN brake the server uses: per caller as above, plus every `total` wrong PINs from everyone together pause every
 * new login, growing the same way. A caller key can be dodged (a new address per try, or a page rebound to 127.0.0.1
 * sending its own X-Forwarded-For), the total cannot: past the first few pauses it allows `total` guesses an hour, so a
 * 4-digit PIN takes about a week on average instead of hours. Browsers that already hold the cookie never notice.
 */
export function pinAttempts({ perCaller = 5, total = 30, ...pacing }: { perCaller?: number; total?: number } & Pacing = {}): AttemptLimiter & {
  /** How long the pause everyone is in lasts (see pause), 0 when there is none. */
  sharedPause(): number;
} {
  const one = attemptLimiter({ max: perCaller, ...pacing });
  const all = attemptLimiter({ max: total, ...pacing });
  return {
    wait: (key) => Math.max(one.wait(key), all.wait('all')),
    pause: (key) => Math.max(one.pause(key), all.pause('all')),
    sharedPause: () => all.pause('all'),
    fail: (key) => { one.fail(key); all.fail('all'); },
    clear: (key) => one.clear(key),   // the total stays: one right PIN must not reset someone else's guessing
    size: () => one.size(),
  };
}

/**
 * A shared pause this long means 150 wrong PINs or more from everyone together, with no day's rest: someone keeps
 * guessing. The full /health says so (`pinPaused`) while it lasts.
 */
export const LONG_PAUSE_MS = 16 * 60_000;

/** Under 6 digits a steady guesser at the brake's 30 an hour finds the PIN in days to months (4 digits: a week on average; 6: two years). Kino warns at startup. */
export const shortPin = (pin: string): boolean => pin.length < 6;

/** The lock screen's 429 message for a pause of `ms`, rounded up to whole minutes, or hours from an hour on. */
export function pauseText(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000)), h = Math.ceil(min / 60);
  const left = min < 60 ? `${min} minute${min === 1 ? '' : 's'}` : h === 1 ? 'an hour' : `${h} hours`;
  return `Too many wrong PINs. Try again in ${left}.`;
}

const OPEN = ['/api/file/', '/api/hls/', '/api/subs/file/', '/api/cast/upnext/'];
/**
 * What the PIN gate lets through without the cookie, by the full path without query: the lock screen's POST /api/auth,
 * and media that TVs, Chromecasts and ffmpeg fetch without cookies, read only (GET, HEAD). An HLS session's seek, ping
 * and DELETE come from the player, which holds the cookie, so they stay locked.
 */
export function pinOpen(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (path === '/api/auth') return m === 'POST';
  return (m === 'GET' || m === 'HEAD') && OPEN.some((p) => path.startsWith(p));
}
