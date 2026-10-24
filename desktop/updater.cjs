// Updates from GitHub releases. The app is not signed with an Apple Developer ID, so Electron's autoUpdater (Squirrel,
// which checks the signature) cannot be used. Instead: read the latest release, offer it, and on yes download the
// DMG (or AppImage), check its size and SHA-256, and swap it in. On a Mac the new Kino.app is copied out of the DMG
// and a detached shell script (update-rules.cjs SWAP_SCRIPT) moves it over the installed one once this app has quit,
// then opens it. Node downloads carry no quarantine flag, so Gatekeeper does not ask again. Where the app cannot
// replace itself (a read-only or translocated copy, a Linux install that is not an AppImage), the DMG or the release
// page opens instead.
'use strict';
const { app, net, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');
const { isNewer, pickAsset, appBundle, SWAP_SCRIPT } = require('./update-rules.cjs');

const LATEST = 'https://api.github.com/repos/vicjor/kino/releases/latest';
const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 6 * 3600_000;

/** The newer release, once one is found: { version, page, asset } (asset null when this install cannot take it). */
let found = null;
let installing = false;
let offered = '';
let opts = { isBusy: async () => false, onChange: () => {} };

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out))));
const changed = () => opts.onChange();

async function latest() {
  const res = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Kino/${app.getVersion()}` } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json();
}

/** Looks for a newer release. manual (the menu item) also says when there is none or the check failed. */
async function check(manual = false) {
  let rel;
  try { rel = await latest(); } catch (e) {
    if (manual) dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: String(e.message || e) });
    return;
  }
  if (!rel || !isNewer(rel.tag_name, app.getVersion())) {
    found = null; changed();
    if (manual) dialog.showMessageBox({ message: 'Kino is up to date', detail: `Version ${app.getVersion()} is the newest.` });
    return;
  }
  const canSwap = process.platform === 'darwin' || !!process.env.APPIMAGE;
  found = { version: String(rel.tag_name).replace(/^v/, ''), page: String(rel.html_url || ''), asset: canSwap ? pickAsset(rel.assets, process.platform, process.arch) : null };
  changed();
  if (manual || offered !== found.version) { offered = found.version; offer(); }
}

async function offer() {
  if (!found || installing) return;
  const { response } = await dialog.showMessageBox({
    type: 'info', message: `Kino ${found.version} is available`,
    detail: found.asset ? `You have ${app.getVersion()}. Kino restarts to update, which stops anything playing.` : `You have ${app.getVersion()}. Download the new version from its release page.`,
    buttons: found.asset ? ['Install and Restart', 'Release Notes', 'Later'] : ['Open Release Page', 'Later'],
    defaultId: 0, cancelId: found.asset ? 2 : 1,
  });
  if (response === 0) return found.asset ? install() : shell.openExternal(found.page);
  if (response === 1 && found.asset) shell.openExternal(found.page);
}

/** Streams the file to dest, then checks its size and (when GitHub gives one) its SHA-256. */
async function download(asset, dest) {
  const res = await net.fetch(asset.url, { headers: { 'User-Agent': `Kino/${app.getVersion()}` } });
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
  await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(dest));
  if (asset.size && bytes !== asset.size) throw new Error(`The download is ${bytes} bytes, ${asset.size} expected.`);
  if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('The download does not match its checksum.');
}

async function installMac(dir, dmg) {
  const bundle = appBundle(process.execPath);
  let writable = !!bundle;
  try { if (bundle) fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch { writable = false; }
  if (!writable) {
    // Not ours to replace in place: open the DMG for a drag to Applications.
    await shell.openPath(dmg);
    dialog.showMessageBox({ message: 'Drag Kino to Applications', detail: 'Kino cannot replace itself where it is. Quit Kino, then drag the new one from the window that opened into Applications.' });
    return false;
  }
  const mnt = path.join(dir, 'mnt'), staged = path.join(dir, 'Kino.app');
  await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt]);
  try { await run('ditto', [path.join(mnt, 'Kino.app'), staged]); } finally { await run('hdiutil', ['detach', mnt, '-force']).catch(() => {}); }
  await run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
  spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'kino-update', String(process.pid), bundle, staged, dir], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

async function install() {
  if (!found || !found.asset || installing) return;
  if (await opts.isBusy()) {
    const { response } = await dialog.showMessageBox({ type: 'warning', message: 'Someone is watching', detail: 'Restarting Kino now stops playback on every screen and TV.', buttons: ['Restart Anyway', 'Later'], defaultId: 1, cancelId: 1 });
    if (response !== 0) return;
  }
  installing = true; changed();
  let dir = '';
  try {
    if (process.platform === 'darwin') {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-update-'));
      const dmg = path.join(dir, found.asset.name);
      await download(found.asset, dmg);
      const swapping = await installMac(dir, dmg);
      dir = ''; // the swap script removes it, or the DMG stays open for the drag
      if (!swapping) return;
    } else {
      // Next to the AppImage, so the rename over it stays on one file system.
      const target = process.env.APPIMAGE, next = `${target}.update`;
      try { await download(found.asset, next); fs.chmodSync(next, 0o755); fs.renameSync(next, target); } finally { fs.rmSync(next, { force: true }); }
      app.relaunch({ execPath: target, args: [] });
    }
    app.quit();
  } catch (e) {
    const { response } = await dialog.showMessageBox({ type: 'error', message: 'The update did not install', detail: `${e.message || e}\n\nYou can download it from the release page instead.`, buttons: ['Open Release Page', 'OK'], defaultId: 0, cancelId: 1 });
    if (response === 0) shell.openExternal(found.page);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    installing = false; changed();
  }
}

/** The tray or menu item for the update, or null when there is none. */
function menuItem() {
  if (!found) return null;
  if (installing) return { label: `Installing Kino ${found.version}…`, enabled: false };
  return { label: `Update to Kino ${found.version}`, click: offer };
}

/** Checks soon after launch and every few hours. isBusy: whether a restart would stop playback. onChange: rebuild menus. */
function start(o) {
  opts = { ...opts, ...o };
  setTimeout(() => check(), FIRST_CHECK_MS).unref();
  setInterval(() => check(), EVERY_MS).unref();
}

module.exports = { start, check, menuItem };
