// App-shell cache only. Network first; fall back to cache when offline. Never touches /api.
const SHELL = 'kino-shell-v2';
// Every /assets/ file this build ships, written in by the build (kino:sw-assets in vite.config.ts); null in dev.
// The list also makes this file differ on every deploy, which is what gets a phone to install the new worker at all.
const ASSETS = /* kino:assets */ null;
// The page and the files client/public ships. addAll fails the whole install on one 404, so test/sw.test.ts checks they exist.
const SHELL_FILES = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
// Cache this build's page and bundles before taking over: activate drops the old bundles, so a PWA opened offline
// right after a deploy would otherwise find a cached "/" whose scripts are gone. If a fetch fails, the install fails
// and the old worker keeps its own consistent shell until the next try.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    if (ASSETS) await (await caches.open(SHELL)).addAll([...SHELL_FILES, ...ASSETS]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    // Hashed bundles from earlier deploys would otherwise stay on the phone forever. The shell itself (/, icons) stays.
    if (ASSETS) {
      const keep = new Set(ASSETS);
      const c = await caches.open(SHELL);
      for (const req of await c.keys()) { const p = new URL(req.url).pathname; if (p.startsWith('/assets/') && !keep.has(p)) await c.delete(req); }
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname === '/health') return;
  const isShell = url.pathname === '/' || url.pathname.startsWith('/assets/') || /\.(svg|png|webmanifest|html)$/.test(url.pathname);
  if (!isShell) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || (url.pathname === '/' ? caches.match('/') : undefined)))
  );
});
