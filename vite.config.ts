import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { SW_ASSETS_MARK } from './scripts/check-sw.ts';

// The API the dev client proxies to. 1234 is production on this Mac, `bun run dev:iso` points it at a dev server on 1299.
const API_PORT = Number(process.env.KINO_API_PORT || 1234);
const PROXIED = ['/api', '/health'];

/**
 * vite's dependency cache, one per checkout: node_modules/.vite-<folder>-<hash of its path>. Worktrees link node_modules
 * from the main checkout, so the default node_modules/.vite would be one folder that parallel dev servers overwrite.
 */
export const cacheDirFor = (root: string): string =>
  path.join(root, 'node_modules', `.vite-${path.basename(root)}-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 8)}`);

const apiUp = () => new Promise<boolean>((resolve) => {
  const socket = net.connect({ port: API_PORT, host: '127.0.0.1' });
  const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
  socket.once('connect', () => done(true)).once('error', () => done(false));
});

/**
 * The API imports webtorrent, so it needs a few seconds to bind while vite is
 * ready in under one. Without this the first page load fires every request at a
 * dead port, fills the terminal with ECONNREFUSED and needs a manual refresh.
 * Only the window before the API first answers waits; after that a crashed
 * server still fails fast, so a real outage stays visible.
 */
const holdUntilApiUp = (): Plugin => ({
  name: 'kino:hold-until-api-up',
  configureServer(server) {
    let up = false;
    let announced = false;
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? '';
      if (up || !PROXIED.some((p) => url === p || url.startsWith(p + '/'))) return next();
      void (async () => {
        if (!announced) { announced = true; server.config.logger.info(`  waiting for the API on :${API_PORT}`); }
        for (let i = 0; i < 60 && !up; i++) {
          if (await apiUp()) up = true;
          else await new Promise((r) => setTimeout(r, 250));
        }
        next();
      })();
    });
  },
});

/**
 * Writes every /assets/ file of this build into the copied sw.js. On activate the worker drops cached bundles that
 * are not on the list, and because the list changes with every deploy, so does sw.js, so phones install it at all.
 */
const swAssets = (): Plugin => ({
  name: 'kino:sw-assets',
  apply: 'build',
  writeBundle(out, bundle) {
    const file = path.join(out.dir || '', 'sw.js');
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(SW_ASSETS_MARK)) this.error(`sw.js has no ${SW_ASSETS_MARK} marker for the asset list`);
    const assets = Object.keys(bundle).filter((f) => f.startsWith('assets/')).sort().map((f) => `/${f}`);
    fs.writeFileSync(file, src.replace(SW_ASSETS_MARK, JSON.stringify(assets)));
  },
});

export default defineConfig({
  root: 'client',
  cacheDir: cacheDirFor(import.meta.dirname),
  plugins: [react(), holdUntilApiUp(), swAssets()],
  build: { outDir: '../dist/client', emptyOutDir: true, sourcemap: false },
  server: {
    host: true, // phones and TVs on the LAN reach the dev client at http://<lan-ip>:5173
    allowedHosts: ['.local'], // and as http://kino.local:5173, the name the dev API registers
    port: 5173,
    // changeOrigin rewrites Host to :1234 but the browser's Origin stays :5173; xfwd passes the original
    // host along as X-Forwarded-Host so the API's cross-site check (server/csrf.ts) still sees a match.
    proxy: Object.fromEntries(PROXIED.map((p) => [p, { target: `http://localhost:${API_PORT}`, changeOrigin: true, xfwd: true }])),
  },
});
