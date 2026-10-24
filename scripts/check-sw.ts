/**
 * Finds every file the built sw.js pre-caches that the build does not have. Its install handler addAll()s the page,
 * manifest, icons and every bundle, and one 404 fails the whole install: every phone keeps its old worker and never
 * updates, with nothing to show for it. scripts/verify-build.ts fails a build on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** The marker in client/public/sw.js that the build (kino:sw-assets in vite.config.ts) replaces with its asset list. */
export const SW_ASSETS_MARK = '/* kino:assets */ null';
/** What sw.js pre-caches before the bundles, in its order: the page and the files client/public ships. Tests hold sw.js to it. */
export const SW_SHELL_FILES: readonly string[] = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];

const ORIGIN = 'https://kino.invalid';
type Lifecycle = (e: { waitUntil(p: Promise<unknown>): void }) => void;

/** The URLs this sw.js source pre-caches: its install handler, run against a CacheStorage that only writes them down. */
export async function precached(src: string): Promise<string[]> {
  const urls: string[] = [];
  const cache = { addAll: async (list: string[]) => { urls.push(...list); }, add: async (url: string) => { urls.push(url); } };
  let install: Lifecycle | undefined;
  const self = { addEventListener: (type: string, f: Lifecycle) => { if (type === 'install') install = f; }, skipWaiting: async () => undefined };
  vm.runInNewContext(src, { self, caches: { open: async () => cache }, URL, location: { origin: ORIGIN } });
  if (!install) throw new Error('sw.js has no install handler');
  let done: Promise<unknown> = Promise.resolve();
  install({ waitUntil: (p) => { done = p; } });
  await done;
  return urls;
}

/** The URLs with no file behind them in `dir`, resolved as the worker at /sw.js resolves them: "/" is index.html. */
export function missing(dir: string, urls: string[]): string[] {
  return urls.filter((u) => {
    const { origin, pathname } = new URL(u, `${ORIGIN}/sw.js`);
    const file = path.join(dir, decodeURIComponent(pathname).replace(/\/$/, '/index.html'));
    return origin !== ORIGIN || !fs.statSync(file, { throwIfNoEntry: false })?.isFile();
  });
}

/** What is wrong with the client build in `dir` for its service worker, one line each; empty when nothing is. */
export async function checkSw(dir: string): Promise<string[]> {
  const sw = path.join(dir, 'sw.js');
  if (!fs.existsSync(sw)) return [`no sw.js in ${dir}`];
  const urls = await precached(fs.readFileSync(sw, 'utf8'));
  if (!urls.length) return ['sw.js pre-caches nothing: the build did not write its asset list in (kino:sw-assets in vite.config.ts)'];
  return missing(dir, urls).map((u) => `sw.js pre-caches ${u}, which the build does not have`);
}
