import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rules = require('../desktop/url-rules.cjs') as {
  appOrigins: (...urls: string[]) => string[];
  isAppUrl: (url: string, origins: string[]) => boolean;
  isExternalOk: (url: string) => boolean;
  permissionOk: (permission: string, requestingUrl: string, topUrl: string, origins: string[]) => boolean;
};
const { appOrigins, isAppUrl, isExternalOk, permissionOk } = rules;

const PROD = appOrigins('http://localhost:1234', 'http://localhost:1234');
const DEV = appOrigins('http://localhost:1299', 'http://localhost:5174');

test('appOrigins: one entry per origin, paths and junk dropped', () => {
  assert.deepEqual(PROD, ['http://localhost:1234']);
  assert.deepEqual(DEV, ['http://localhost:1299', 'http://localhost:5174']);
  assert.deepEqual(appOrigins('http://localhost:5174/#/title/x', '', 'not a url', 'file:///tmp/a.html'), ['http://localhost:5174']);
});

test('isAppUrl: same origin only, a prefix match is not enough', () => {
  assert.equal(isAppUrl('http://localhost:1234/', PROD), true);
  assert.equal(isAppUrl('http://localhost:1234/#/title/tt0111161', PROD), true);
  assert.equal(isAppUrl('http://LOCALHOST:1234/api/x', PROD), true);
  assert.equal(isAppUrl('http://localhost:1234@other.host/', PROD), false);
  assert.equal(isAppUrl('http://localhost:12345/', PROD), false);
  assert.equal(isAppUrl('http://localhost:1234.other.host/', PROD), false);
  assert.equal(isAppUrl('https://localhost:1234/', PROD), false);
  assert.equal(isAppUrl('http://127.0.0.1:1234/', PROD), false);
  assert.equal(isAppUrl('https://www.imdb.com/title/tt0111161/', PROD), false);
  assert.equal(isAppUrl('http://localhost:5174/', DEV), true);
  assert.equal(isAppUrl('http://localhost:1299/health', DEV), true);
  assert.equal(isAppUrl('http://localhost:1234/', DEV), false);
  assert.equal(isAppUrl('about:blank', PROD), false);
  assert.equal(isAppUrl('', PROD), false);
  assert.equal(isAppUrl('not a url', PROD), false);
});

test('isExternalOk: http and https only', () => {
  assert.equal(isExternalOk('https://www.imdb.com/title/tt0111161/'), true);
  assert.equal(isExternalOk('http://kino.local:1234/'), true);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'magnet:?xt=urn:btih:abc', 'vbscript:x', 'data:text/html,hi', 'mailto:a@b.c', '', 'imdb.com'])
    assert.equal(isExternalOk(u), false, u);
});

test('permissionOk: fullscreen in a Kino page (trailer iframe too), Paste for Kino only, nothing else', () => {
  const page = 'http://localhost:1234/#/title/tt0111161', yt = 'https://www.youtube-nocookie.com/embed/abc';
  assert.equal(permissionOk('fullscreen', page, page, PROD), true);
  assert.equal(permissionOk('fullscreen', yt, page, PROD), true);
  assert.equal(permissionOk('fullscreen', 'https://other.host/', 'https://other.host/', PROD), false);
  assert.equal(permissionOk('clipboard-read', page, page, PROD), true);
  assert.equal(permissionOk('clipboard-read', yt, page, PROD), false);
  for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-sanitized-write', 'midi', 'hid', 'unknown'])
    assert.equal(permissionOk(p, page, page, PROD), false, p);
});

// main.cjs with electron stubbed: what a launch registers depending on the single-instance lock.
const ELECTRON = require.resolve('electron');
const MAIN = require.resolve('../desktop/main.cjs');
const ENV_KEYS = ['PORT', 'NODE_ENV', 'KINO_DATA', 'KINO_LOG_FILE', 'KINO_CLIENT_DIR', 'KINO_DEV_URL', 'KINO_USER_DATA'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
after(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  delete require.cache[ELECTRON]; delete require.cache[MAIN];
});

/** Electron's own folders in the fake: userData is what Kino.app uses until setPath moves it. */
const APP_DATA = '/nonexistent/Application Support', KINO_APP = `${APP_DATA}/Kino`;

function launch(lockHeld: boolean, devUrl = '', env: Record<string, string> = {}): string[] {
  const calls: string[] = [];
  const paths: Record<string, string> = { appData: APP_DATA, userData: KINO_APP };
  const app = {
    getPath: (name: string) => paths[name] ?? `/nonexistent/${name}`,
    setPath: (name: string, p: string) => { calls.push(`setPath:${name}:${p}`); paths[name] = p; },
    requestSingleInstanceLock: () => { calls.push('lock'); return lockHeld; },
    quit: () => { calls.push('quit'); },
    on: (ev: string) => { calls.push(`on:${ev}`); return app; },
    whenReady: () => { calls.push('whenReady'); return new Promise(() => {}); },
  };
  for (const k of ENV_KEYS) delete process.env[k];
  if (devUrl) process.env.KINO_DEV_URL = devUrl;
  Object.assign(process.env, env);
  require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: { app } } as unknown as NodeJS.Module;
  delete require.cache[MAIN];
  require(MAIN);
  return calls;
}

test('main.cjs: a second launch quits without starting a server, tray or window', () => {
  assert.deepEqual(launch(false), ['lock', 'quit']);
});

test('main.cjs: the launch that holds the lock waits for ready and wakes on a second launch', () => {
  const calls = launch(true);
  assert.equal(calls.includes('quit'), false);
  for (const c of ['whenReady', 'on:second-instance', 'on:activate', 'on:window-all-closed', 'on:before-quit']) assert.ok(calls.includes(c), c);
  assert.equal(process.env.PORT, '1234');
});

test('main.cjs: a dev window defaults to the dev:iso API on :1299, never production on :1234', () => {
  launch(true, 'http://localhost:5174');
  assert.equal(process.env.PORT, '1299');
  assert.equal(process.env.NODE_ENV, 'development');
});

test('main.cjs: PORT, KINO_DATA and KINO_LOG_FILE from the environment win (scripts/desktop.sh sets them in a worktree)', () => {
  launch(true, '', { PORT: '1299', KINO_DATA: '/tmp/kino-desktop.x', KINO_LOG_FILE: '/tmp/kino-desktop.x/kino.log' });
  assert.equal(process.env.PORT, '1299');
  assert.equal(process.env.KINO_DATA, '/tmp/kino-desktop.x');
  assert.equal(process.env.KINO_LOG_FILE, '/tmp/kino-desktop.x/kino.log');
});

test('main.cjs: the installed app keeps Electron\'s own folder (Kino), data and log inside it', () => {
  const calls = launch(true);
  assert.equal(calls.some((c) => c.startsWith('setPath')), false);
  assert.equal(process.env.KINO_DATA, `${KINO_APP}/data`);
  assert.equal(process.env.KINO_LOG_FILE, `${KINO_APP}/kino.log`);
});

test('main.cjs: KINO_USER_DATA moves Electron\'s folder before the lock, so Kino.app holding its lock does not quit a worktree app', () => {
  const calls = launch(false, '', { KINO_USER_DATA: '/tmp/kino-desktop-app.x' });
  assert.deepEqual(calls.slice(0, 2), ['setPath:userData:/tmp/kino-desktop-app.x', 'lock']);
  launch(true, '', { KINO_USER_DATA: '/tmp/kino-desktop-app.x' });
  assert.equal(process.env.KINO_DATA, '/tmp/kino-desktop-app.x/data', 'no KINO_DATA given: data goes with it');
  launch(true, '', { KINO_USER_DATA: '/tmp/kino-desktop-app.x', KINO_DATA: '/tmp/kino-desktop.x' });
  assert.equal(process.env.KINO_DATA, '/tmp/kino-desktop.x');
});

test('main.cjs: a dev window gets its own Electron folder (Kino Dev) before the lock; KINO_USER_DATA still wins', () => {
  assert.deepEqual(launch(true, 'http://localhost:5174').slice(0, 2), [`setPath:userData:${APP_DATA}/Kino Dev`, 'lock']);
  assert.deepEqual(launch(true, 'http://localhost:5174', { KINO_USER_DATA: '/tmp/k' }).slice(0, 2), ['setPath:userData:/tmp/k', 'lock']);
});
