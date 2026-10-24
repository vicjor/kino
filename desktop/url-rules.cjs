// Where a Kino window may go and what it may use. Pure (no Electron), so test/desktop.test.ts loads it directly.
'use strict';

/** The origin of url, or '' when it does not parse. Origins, not prefixes: http://localhost:1234@other.host is other.host. */
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }

/** The app's own origins from its page URLs (the Kino server, plus vite in dev), deduplicated. */
function appOrigins(...urls) { return [...new Set(urls.filter(Boolean).map(originOf).filter((o) => o && o !== 'null'))]; }

/** True when url is on one of the app's origins, so it may load inside a Kino window. */
function isAppUrl(url, origins) { const o = originOf(url); return o !== '' && o !== 'null' && origins.includes(o); }

/** True when url may go to the system browser: http and https only, never file:, javascript: or another app's scheme. */
function isExternalOk(url) { try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; } catch { return false; } }

/**
 * Whether a frame may have a permission (Electron grants every one when no handler is set). Fullscreen for any frame
 * in a Kino page: the player, and the trailer iframe, which has allowfullscreen. clipboard-read for Kino itself only:
 * Paste on the magnet screen. Everything else is denied: Kino uses no camera, location, notifications or the like.
 */
function permissionOk(permission, requestingUrl, topUrl, origins) {
  if (permission === 'fullscreen') return isAppUrl(topUrl, origins);
  if (permission === 'clipboard-read') return isAppUrl(requestingUrl, origins) && isAppUrl(topUrl, origins);
  return false;
}

module.exports = { appOrigins, isAppUrl, isExternalOk, permissionOk };
