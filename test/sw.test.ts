import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SW_ASSETS_MARK as MARK, SW_SHELL_FILES as SHELL_FILES } from '../scripts/check-sw.ts';

const SRC = readFileSync(new URL('../client/public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://kino.test';

type Lifecycle = (e: { waitUntil: (p: Promise<unknown>) => void }) => void;

/**
 * Runs sw.js against an in-memory CacheStorage seeded with paths per cache. `fire` runs install or activate and
 * waits for its waitUntil; `left` is what each cache holds; `log` is the order of addAll and skipWaiting calls.
 * Every path in `unreachable` fails an addAll, as a 404 or a dropped connection would.
 */
function worker(assets: string[] | null, seed: Record<string, string[]>, unreachable: string[] = []) {
  const store = new Map(Object.entries(seed).map(([name, paths]) => [name, new Set(paths.map((p) => ORIGIN + p))]));
  const log: string[] = [];
  const caches = {
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    open: async (name: string) => {
      const urls = store.get(name) ?? new Set<string>(); store.set(name, urls);
      return {
        keys: async () => [...urls].map((url) => ({ url })),
        delete: async (req: { url: string }) => urls.delete(req.url),
        addAll: async (paths: string[]) => {
          log.push(`addAll ${paths.length}`);
          const bad = paths.find((p) => unreachable.includes(p));
          if (bad) throw new TypeError(`Failed to fetch ${bad}`);   // all or nothing, as the real one is
          for (const p of paths) urls.add(ORIGIN + p);
        },
      };
    },
  };
  const handlers: Record<string, Lifecycle> = {};
  const self = {
    addEventListener: (type: string, f: Lifecycle) => { handlers[type] = f; },
    skipWaiting: async () => { log.push('skipWaiting'); },
    clients: { claim: async () => undefined },
  };
  vm.runInNewContext(assets ? SRC.replace(MARK, JSON.stringify(assets)) : SRC, { self, caches, URL, location: { origin: ORIGIN } });
  return {
    log,
    async fire(type: 'install' | 'activate') {
      let done: Promise<unknown> = Promise.resolve();
      handlers[type]({ waitUntil: (p) => { done = p; } });
      await done;
    },
    left: () => Object.fromEntries([...store].map(([name, urls]) => [name, [...urls].map((u) => u.slice(ORIGIN.length)).sort()])),
  };
}

/** Runs sw.js, fires activate, returns what is left. */
async function activate(assets: string[] | null, seed: Record<string, string[]>): Promise<Record<string, string[]>> {
  const w = worker(assets, seed);
  await w.fire('activate');
  return w.left();
}

const SHELL = 'kino-shell-v2';
const cached = ['/', '/icon-180.png', '/assets/index-new.js', '/assets/Title-new.js', '/assets/index-old.js', '/assets/Title-old.js', '/assets/old.css'];
const NEW = ['/assets/Player-new.js', '/assets/Title-new.js', '/assets/index-new.js', '/assets/index-new.css'];

test('sw.js: carries the marker the build fills with its asset list', () => {
  assert.ok(SRC.includes(MARK));
});

test('sw.js activate: drops bundles from earlier builds, keeps this build and the shell', async () => {
  const left = await activate(['/assets/index-new.js', '/assets/Title-new.js', '/assets/Player-new.js'], { [SHELL]: cached, 'kino-shell-v1': ['/', '/icon.svg'] });
  assert.deepEqual(left, { [SHELL]: ['/', '/assets/Title-new.js', '/assets/index-new.js', '/icon-180.png'] });
});

test('sw.js activate: without a list (dev) only other caches go', async () => {
  const left = await activate(null, { [SHELL]: cached, 'kino-shell-v0': ['/'] });
  assert.deepEqual(left, { [SHELL]: [...cached].sort() });
});

test('sw.js install: caches the page, manifest, icons and every bundle of this build, then takes over', async () => {
  const w = worker(NEW, {});
  await w.fire('install');
  assert.deepEqual(w.left(), { [SHELL]: [...SHELL_FILES, ...NEW].sort() });
  assert.deepEqual(w.log, [`addAll ${SHELL_FILES.length + NEW.length}`, 'skipWaiting'], 'cached before it takes over');
});

test('sw.js install then activate: right after a deploy the cached page has every bundle it loads, the old ones are gone', async () => {
  const w = worker(NEW, { [SHELL]: cached });
  await w.fire('install');
  await w.fire('activate');
  assert.deepEqual(w.left(), { [SHELL]: [...SHELL_FILES, ...NEW].sort() });
});

test('sw.js install: a file it cannot fetch fails the install, so the old worker and its cache stay', async () => {
  const w = worker(NEW, { [SHELL]: cached }, ['/assets/index-new.css']);
  await assert.rejects(w.fire('install'), /Failed to fetch/);
  assert.deepEqual(w.log, [`addAll ${SHELL_FILES.length + NEW.length}`], 'no skipWaiting');
  assert.deepEqual(w.left(), { [SHELL]: [...cached].sort() });
});

test('sw.js install: without a list (dev) caches nothing and takes over at once', async () => {
  const w = worker(null, {});
  await w.fire('install');
  assert.deepEqual(w.log, ['skipWaiting']);
  assert.deepEqual(w.left(), {});
});

test('sw.js install: every shell file it pre-caches ships in client/public (one 404 fails every update), every manifest icon is one', async () => {
  const w = worker(['/assets/x.js'], {});
  await w.fire('install');
  const files = w.left()[SHELL].filter((p) => !p.startsWith('/assets/'));
  assert.deepEqual(files, [...SHELL_FILES].sort());
  for (const p of files.filter((f) => f !== '/')) assert.ok(existsSync(new URL(`../client/public${p}`, import.meta.url)), p);
  const manifest = JSON.parse(readFileSync(new URL('../client/public/manifest.webmanifest', import.meta.url), 'utf8')) as { icons: { src: string }[] };
  for (const { src } of manifest.icons) assert.ok(files.includes(src), src);
});
