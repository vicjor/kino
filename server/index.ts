import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { PORT, PLAIN_PORT, PIN as KINO_PIN, CLIENT_DIR, DATA_DIR, HLS_DIR, ensureDirs, lanIp } from './config.js';
import { logger } from './log.js';
import { load, flushSync, recoveryNotice, repairNotice } from './store.js';
import * as torrent from './torrent.js';
import * as hls from './media/hls.js';
import * as discovery from './cast/discovery.js';
import * as mdnsName from './mdns-name.js';
import * as cast from './cast/manager.js';
import * as monitor from './cast/monitor.js';
import * as dlna from './cast/dlna.js';
import * as downloads from './downloads.js';
import * as rails from './discover.js';
import { ensureDatasets, datasetAge } from './ratings.js';
import { freeBytes } from './disk.js';
import { isBusy, watching } from './health.js';
import { pinToken, sameSecret, cookieValues, pinAttempts, attemptKey, pinOpen, pauseText, shortPin, LONG_PAUSE_MS } from './pin.js';
import { secretKey } from './subs/ids.js';
import { api } from './routes/index.js';
import { jsonErrors, apiNotFound } from './errors.js';
import { announceShutdown } from './events.js';
import { isCrossSiteWrite } from './csrf.js';
import { reapOrphanTranscoders, runShutdown, refuseWhileStopping } from './lifecycle.js';
import { hostGuard, envHosts, plainRedirect, UNKNOWN_HOST } from './host.js';

const log = logger('main');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')).version as string; } catch { try { return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version as string; } catch { return 'dev'; } } })();
const started = Date.now();

const app = express();
app.set('trust proxy', false);
app.disable('x-powered-by');
app.use(refuseWhileStopping);   // shutting down: a 503 and a closed connection, nothing new starts
// DNS rebinding: a page on a name its owner points at this Mac is same-origin to the browser. Only names that cannot be rebound get in.
app.use(hostGuard());
// A page on another site can still make a LAN browser send a write (a text/plain POST needs no preflight): refuse it.
app.use('/api', (req, res, next) => { if (isCrossSiteWrite(req.method, req.headers)) { log.warn('cross-site write refused', { method: req.method, path: req.originalUrl.split('?')[0], origin: req.headers.origin }); res.status(403).json({ error: 'Cross-site request refused' }); return; } next(); });
// JSON bodies only. The progress beacon (text/plain) gets its own parser on that one route.
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { if (!/^\/api\/(file|hls)\//i.test(req.path)) log.debug(req.method + ' ' + req.originalUrl); next(); });

// Optional PIN (KINO_PIN=1234): guests on the Wi-Fi see a lock screen instead of your library.
// Media endpoints stay open to GET and HEAD because TVs and Chromecasts fetch them without cookies (pinOpen).
const PIN = KINO_PIN;   // a local const, so TypeScript narrows it in the handlers below (an import it does not)
const tries = pinAttempts();   // every 5 wrong PINs per visitor, or 30 from everyone, pause: a minute, then twice as long each time up to an hour
// Cookie value derived from the PIN and DATA_DIR/secret.key, read on the first request (the port is ours by then).
let token = '';
const cookieToken = (pin: string) => (token ||= pinToken(pin, secretKey()));
/** No PIN, or this browser holds the cookie the right PIN set. */
const unlocked = (req: express.Request) => !PIN || cookieValues(req.headers.cookie, 'kino_auth').some((v) => sameSecret(v, cookieToken(PIN)));

app.get('/health', (req, res) => {
  const viewers = watching({ openStreams: torrent.openStreams(), transcoderStreams: torrent.transcoderStreams(), held: downloads.heldCount(), sessions: hls.active(), cast: cast.status().active });
  const uptime = Math.round((Date.now() - started) / 1000), busy = isBusy(viewers);
  // Locked out: only what the deploy scripts read (busy, uptime for the restart check). No paths, names or devices.
  if (!unlocked(req)) { res.json({ ok: true, version: VERSION, uptime, busy }); return; }
  const { free } = freeBytes(); const ff = hls.binStatus('ffmpeg'), fp = hls.binStatus('ffprobe');   // runnable, not just present (cached; *Checking: a background re-check runs, the boolean is the answer from before it)
  res.json({ ok: true, version: VERSION, uptime, node: process.version, freeBytes: free, activeTorrents: torrent.activeTorrents(), ...viewers, busy, castDevices: discovery.list().length, lanIp: lanIp(), hostname: mdnsName.hostname(), ffmpeg: ff.ok, ffmpegPath: ff.path, ffmpegChecking: ff.checking, ffprobe: fp.ok, ffprobePath: fp.path, ffprobeChecking: fp.checking, hwEncoder: hls.hwEnabled(), imdbDatasets: datasetAge(), platform: process.platform, dataDir: DATA_DIR, stateRecovered: recoveryNotice(), stateRepaired: repairNotice(), ...(tries.sharedPause() >= LONG_PAUSE_MS ? { pinPaused: true } : {}) });
});
if (PIN) {
  app.post('/api/auth', (req, res) => {
    const who = attemptKey(req.socket.remoteAddress, req.headers['x-forwarded-for']);   // a tailnet visitor, not the proxy's loopback
    const pause = (ms: number) => { res.setHeader('Retry-After', String(Math.ceil(ms / 1000))); res.status(429).json({ error: pauseText(ms) }); };
    const wait = tries.wait(who);
    if (wait > 0) { pause(wait); return; }
    if (!sameSecret(String(req.body?.pin || ''), PIN)) {
      tries.fail(who);
      const now = tries.wait(who);   // the try that reaches the limit already says so, the lock screen pauses at once
      if (now > 0) { log.warn('wrong pin limit reached, pausing', { ip: who }); pause(now); return; }
      res.status(401).json({ error: 'Wrong PIN' }); return;
    }
    tries.clear(who);
    res.setHeader('Set-Cookie', `kino_auth=${cookieToken(PIN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    if (pinOpen(req.method, `/api${req.path}`) || unlocked(req)) return next();   // req.path is what the api router matches
    res.status(401).json({ error: 'PIN required', locked: true });
  });
  log.info('pin protection on');
  if (shortPin(PIN)) log.warn('KINO_PIN is shorter than 6 digits: a steady guesser finds it in days to months, not years. Use 6 or more', { length: PIN.length });
}
app.use('/api', api);
app.use('/api', apiNotFound);   // a path no route serves: JSON, not Express's HTML page
app.use(jsonErrors);   // app level: a body the JSON parser refuses gets JSON too

// static client + SPA fallback
const indexHtml = path.join(CLIENT_DIR, 'index.html');
if (fs.existsSync(indexHtml)) {
  // Files under assets/ carry a content hash, so they never change: no revalidation on repeat loads.
  app.use(express.static(CLIENT_DIR, { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => {
    if (p.endsWith('index.html') || p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    else if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } }));
  // A missing asset (a chunk from before the last deploy) must 404, not come back as index.html:
  // the service worker would cache that page as the chunk and the lazy import would never recover.
  app.get(/^\/(?!api\/|assets\/).*/, (_req, res) => res.sendFile(indexHtml));
} else {
  log.warn('client build not found', { CLIENT_DIR });
}

// Bind the port BEFORE touching shared state. A second instance (a stray
// `tsx watch` next to the launchd service) must not wipe the HLS dir, rewrite
// state.json or start torrents; it just notes the conflict and stays idle.
const server = app.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, lan: `http://${lanIp()}:${PORT}`, ffmpeg: hls.binStatus('ffmpeg').path, ffprobe: hls.binStatus('ffprobe').path });   // resolves both: logs which binary runs and why others were skipped
  ensureDirs();
  load();
  reapOrphanTranscoders(HLS_DIR);   // a dead Kino's ffmpegs, before their folder goes
  hls.wipeAll();
  void hls.detectHwEncoder();
  torrent.reconcile();
  cast.init();   // before DLNA discovery: its adopt guard and listeners are in place for the first renderer
  discovery.start();
  mdnsName.start();
  dlna.start();
  monitor.start();
  downloads.start();
  startPlainRedirect();
  setTimeout(() => void ensureDatasets(), 15_000).unref();   // IMDb dumps ready before anyone opens a title
  setTimeout(() => rails.warm(), 3_000).unref();               // Home rails ready before the first visit
  setInterval(() => hls.reaper(), 30_000).unref();
  setInterval(() => torrent.refreshSizes(), 60_000).unref();
});
server.keepAliveTimeout = 65_000;

// http://kino.local with no port: a bare listener on 80 that sends the browser to :1234. Same
// origin stays :1234 (PWA, service worker, saved state), this only saves typing the port on a
// phone. macOS lets a user process bind 80 since Mojave; anywhere it cannot, we log and move on.
let plain: http.Server | null = null;
function startPlainRedirect(): void {
  if (!PLAIN_PORT || PLAIN_PORT === PORT) return;
  const names = envHosts();
  plain = http.createServer((req, res) => {
    const to = plainRedirect(req.headers.host, req.url, PORT, lanIp(), names);   // same Host check as :PORT, never a redirect to some other name
    if (!to) { res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(UNKNOWN_HOST); return; }
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
    res.end();
  });
  plain.on('error', (e: NodeJS.ErrnoException) => { log.warn('plain http redirect unavailable', { port: PLAIN_PORT, err: e.code || e.message }); plain = null; });
  plain.listen(PLAIN_PORT, '0.0.0.0', () => log.info('redirecting', { from: `http://kino.local:${PLAIN_PORT}`, to: PORT }));
}
// The port is usually busy because the previous Kino is still shutting down (launchd bootout returns
// before it has let go): keep trying for half a minute, then stay idle rather than fight a live install.
let bindTries = 0;
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    if (++bindTries <= 30) { if (bindTries === 1) log.warn('port in use, waiting for it', { port: PORT }); setTimeout(() => server.listen(PORT), 1000); return; }
    log.warn('port in use: another Kino is already running, this process stays idle', { port: PORT });
    return;
  }
  log.error('server error', { err: e.message });
  process.exit(1);
});

let stopping: Promise<void> | null = null;
/**
 * Stop Kino without exiting: state to disk first, transcoders killed, the TV told (2 s at most), the torrent client
 * closed, every connection dropped, state again. Settles within about 4.5 s and never rejects; a second call gets the
 * first one's promise. The signal handlers below exit after it, the desktop app quits itself (desktop/main.cjs).
 */
export function shutdown(why = 'quit'): Promise<void> {
  return (stopping ||= (async () => {
    log.info('shutdown', { why });
    if (!server.listening) return;   // an idle second instance loaded nothing, and must not rewrite state.json
    const t0 = Date.now();
    await runShutdown({
      flush: flushSync,
      now: [
        ['events', announceShutdown],
        ['listen', () => { server.close(); plain?.close(); }],   // no new connections: nothing starts a transcode behind our back
        ['hls', hls.stopAll],
        ['downloads', downloads.stop], ['monitor', monitor.stop], ['dlna', dlna.stopDiscovery], ['discovery', discovery.stop], ['mdns', mdnsName.stop],
      ],
      cast: () => cast.stop(false),
      torrent: torrent.shutdown,
      closeHttp: () => { server.closeAllConnections(); plain?.closeAllConnections(); },   // SSE reconnects and keep-alives would hold close() open
    });
    log.info('shutdown done', { ms: Date.now() - t0 });
  })());
}
/** launchd SIGKILLs a job that outlives its SIGTERM for long. The deadline goes first, so nothing in shutdown can hold the exit past it. */
const EXIT_DEADLINE_MS = 5000;
function onSignal(sig: string): void {
  setTimeout(() => { log.warn('shutdown deadline reached, exiting'); process.exit(0); }, EXIT_DEADLINE_MS).unref();
  void shutdown(sig).finally(() => process.exit(0));
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('uncaughtException', (e) => log.error('uncaught', { err: e.message, stack: e.stack }));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: String(e) }));
