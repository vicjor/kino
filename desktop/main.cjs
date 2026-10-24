// Kino desktop: the same server and UI, wrapped in a window with a tray icon.
// The server keeps running for phones and TVs on the LAN while the window is
// closed; quit from the tray or the Dock to stop it. Data lives in the app's
// own folder (~/Library/Application Support/Kino/data on macOS), the server log
// next to it (kino.log, rotated at 10 MB, 3 files kept).
//
// Dev mode (`bun run dev:desktop`, the dev:iso setup): KINO_DEV_URL points at
// vite on :5174, the window loads that instead of dist/client and the server is
// the tsx watch one on :1299, so both hot-reload. Nothing is built and no data
// folder is created here; the dev server uses its own (~/kino-dev).
//
// Electron's own folder (userData: cookies, storage, the single-instance lock) is Kino.app's unless
// KINO_USER_DATA names another (scripts/desktop.sh in a worktree: a throwaway one) or this is a dev window
// (~/Library/Application Support/Kino Dev). Sharing Kino.app's, a dev or worktree launch would find its lock
// held and quit while Kino.app runs.
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, session } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { appOrigins, isAppUrl, isExternalOk, permissionOk } = require('./url-rules.cjs');

const DEV_URL = process.env.KINO_DEV_URL || '';
// Before anything reads userData and before requestSingleInstanceLock, which keeps its lock in there.
const USER_DATA = process.env.KINO_USER_DATA || (DEV_URL ? path.join(app.getPath('appData'), 'Kino Dev') : '');
if (USER_DATA) app.setPath('userData', USER_DATA);
// Dev defaults to the dev:iso port: a dev window must never attach to the production Kino on :1234.
const PORT = Number(process.env.PORT || (DEV_URL ? 1299 : 1234));
process.env.PORT = String(PORT);
process.env.NODE_ENV = DEV_URL ? 'development' : 'production';
if (!DEV_URL) {
  process.env.KINO_DATA = process.env.KINO_DATA || path.join(app.getPath('userData'), 'data');
  process.env.KINO_LOG_FILE = process.env.KINO_LOG_FILE || path.join(app.getPath('userData'), 'kino.log');
  process.env.KINO_CLIENT_DIR = path.join(__dirname, '..', 'dist', 'client');
  // The DMG's own ffmpeg and ffprobe (scripts/ffmpeg-arch.sh), not ffmpeg-static's, which is left out of it.
  const ff = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : '';
  if (ff && require('node:fs').existsSync(path.join(ff, 'ffmpeg'))) {
    process.env.FFMPEG_BIN = process.env.FFMPEG_BIN || path.join(ff, 'ffmpeg');
    process.env.FFPROBE_BIN = process.env.FFPROBE_BIN || path.join(ff, 'ffprobe');
  }
}
const URL = `http://localhost:${PORT}`;
const PAGE = DEV_URL || URL;
const ORIGINS = appOrigins(URL, PAGE);

let win = null;
let tray = null;
let lanUrl = URL;
/** The server module when this app started it. Null when it attached to another Kino: that one is not ours to stop. */
let server = null;

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/health`, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reachable = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
  req.on('error', () => resolve(false));
  req.setTimeout(2000, () => { req.destroy(); resolve(false); });
});

async function startServer() {
  // Another Kino already on this port (a launchd install, a dev server)? Just attach to it.
  if (await health()) return 'attached';
  if (DEV_URL) {
    // tsx watch imports webtorrent and needs a few seconds to bind. Never start our own.
    for (let i = 0; i < 120; i++) { if (await health()) return 'attached'; await sleep(250); }
    throw new Error(`No Kino API on :${PORT}. Start dev with \`bun run dev:desktop\` (API, vite and this window together); its api output says why the server is not up.`);
  }
  server = await import(path.join(__dirname, '..', 'dist', 'server', 'index.js'));
  for (let i = 0; i < 60; i++) { if (await health()) return 'started'; await sleep(250); }
  throw new Error(`The Kino server did not start. See the log in ${process.env.KINO_LOG_FILE}`);
}

async function waitForPage() {
  if (!DEV_URL) return;
  for (let i = 0; i < 120; i++) { if (await reachable(DEV_URL)) return; await sleep(250); }
  throw new Error(`Vite is not answering at ${DEV_URL}.`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 500, show: false,
    title: 'Kino', backgroundColor: '#000000', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // The traffic lights centred on the page's top row (the 52px tab bar 12px down, global.css .mac-app).
    trafficLightPosition: { x: 20, y: 31 },
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  guard(win.webContents);
  if (DEV_URL) win.webContents.openDevTools({ mode: 'detach' });
  win.loadURL(PAGE);
}

/** External links (IMDb, addon sites) go to the system browser; only Kino's own origins load in a Kino window. */
function guard(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url, ORIGINS)) return { action: 'allow' };
    if (isExternalOk(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Main frame only: the trailer iframe may redirect inside itself (a consent page) without leaving Kino.
  const stay = (e) => {
    if (!e.isMainFrame || isAppUrl(e.url, ORIGINS)) return;
    e.preventDefault();
    if (isExternalOk(e.url)) shell.openExternal(e.url);
  };
  contents.on('will-navigate', stay);
  contents.on('will-redirect', stay);
  contents.on('did-create-window', (child) => guard(child.webContents));
}

/** Fullscreen and Paste only (see permissionOk); Electron would otherwise grant every request and check. */
function limitPermissions(ses) {
  ses.setPermissionRequestHandler((wc, permission, done, details) => done(permissionOk(permission, details.requestingUrl, wc.getURL(), ORIGINS)));
  ses.setPermissionCheckHandler((wc, permission, origin, details) => permissionOk(permission, details.requestingUrl || origin, wc ? wc.getURL() : (details.embeddingOrigin || origin), ORIGINS));
}

function showWindow() { if (win) { win.show(); win.focus(); } else createWindow(); }

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Kino');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: DEV_URL ? 'Open Kino (dev)' : 'Open Kino', click: showWindow },
    { label: `Phones and TVs: ${lanUrl}`, click: () => shell.openExternal(lanUrl) },
    { label: 'Open in browser', click: () => shell.openExternal(URL) },
    { type: 'separator' },
    { label: 'Data folder', click: () => shell.openPath(process.env.KINO_DATA) },
    { type: 'separator' },
    { label: 'Quit Kino', click: () => app.quit() },
  ]));
  rebuild();
  tray.on('click', showWindow);
  health().then((h) => { if (!h) return; if (h.lanIp) lanUrl = `http://${h.hostname || h.lanIp}:${PORT}`; if (h.dataDir) process.env.KINO_DATA = h.dataDir; rebuild(); });
}

// Quitting waits for the server to stop (state saved, transcoders killed, the TV told), at most QUIT_WAIT_MS.
const QUIT_WAIT_MS = 6000;
let stopping = false;
function stopServerFirst(e) {
  if (!server || typeof server.shutdown !== 'function') return;
  e.preventDefault();
  if (stopping) return;
  stopping = true;
  Promise.race([server.shutdown('quit'), sleep(QUIT_WAIT_MS)]).catch(() => {}).finally(() => app.exit(0));
}

// A second launch only wakes the first (second-instance) and quits: no server, tray or window of its own.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    limitPermissions(session.defaultSession);
    try { await startServer(); await waitForPage(); } catch (e) { dialog.showErrorBox('Kino', String(e.message || e)); app.quit(); return; }
    createTray();
    createWindow();
  });
  app.on('activate', showWindow);
  // Closing the window keeps the server alive for the rest of the house.
  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.on('before-quit', stopServerFirst);
}
