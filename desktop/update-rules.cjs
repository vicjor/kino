// What the updater decides, without Electron, so test/desktop-update.test.ts loads it directly.
'use strict';

/** [major, minor, patch] from "v1.2.3" or "1.2.3-beta", or null when it is no version. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when the release tag is a later version than the running one. Junk on either side is never newer. */
function isNewer(tag, current) {
  const a = parseVersion(tag), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The release file this app installs from, or null: the DMG on a Mac (Apple Silicon only), the AppImage for this CPU
 * on Linux. electron-builder names the arm64 builds with "arm64" and leaves the x64 AppImage unmarked.
 */
function pickAsset(assets, platform, arch) {
  const files = (Array.isArray(assets) ? assets : []).filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string');
  const arm = (a) => /arm64/i.test(a.name);
  let hit;
  if (platform === 'darwin' && arch === 'arm64') hit = files.find((a) => /\.dmg$/i.test(a.name) && arm(a));
  else if (platform === 'linux') hit = files.find((a) => /\.AppImage$/.test(a.name) && (arch === 'arm64' ? arm(a) : !arm(a) && !/armv7l/i.test(a.name)));
  if (!hit) return null;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(hit.digest || '');
  return { name: hit.name, url: hit.browser_download_url, size: Number(hit.size) || 0, sha256: sha ? sha[1].toLowerCase() : '' };
}

/**
 * The .app bundle the running Electron binary sits in (/Applications/Kino.app/Contents/MacOS/Kino), or '' when it
 * is not in one or macOS runs it from a read-only translocated copy (opened straight from Downloads, still quarantined).
 */
function appBundle(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  return m && !m[1].includes('/AppTranslocation/') ? m[1] : '';
}

/**
 * The shell script that swaps the new Kino.app in once this one has quit, then opens it.
 *   sh -c SCRIPT kino-update <pid> <installed .app> <new .app> <work folder>
 * Waits up to a minute for the pid to exit and gives up if it does not. A failed swap puts the old app back.
 * The work folder (download and staged app) is removed either way.
 */
const SWAP_SCRIPT = `pid=$1 app=$2 new=$3 dir=$4
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); if [ "$i" -gt 600 ]; then rm -rf "$dir"; exit 1; fi
  sleep 0.1
done
if mv "$app" "$dir/previous.app"; then
  mv "$new" "$app" || mv "$dir/previous.app" "$app"
fi
rm -rf "$dir"
open "$app"
`;

module.exports = { isNewer, pickAsset, appBundle, SWAP_SCRIPT };
