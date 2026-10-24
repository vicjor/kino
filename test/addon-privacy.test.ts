import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const { manifest, getStreams, getAddonSubtitles, addonOrigin, listAddons } = await import('../server/addons.ts');
const { getState } = await import('../server/store.ts');

const TOKEN = 'cfgTOKEN0123456789';
/** A local addon with its config token in the path. Manifest answers per `manifestOk`; streams and subtitles always fail. */
async function addon(manifestOk: boolean): Promise<string> {
  const srv = http.createServer((req, res) => {
    if (manifestOk && req.url?.endsWith('/manifest.json')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'p', name: 'ProviderA', resources: ['stream', 'subtitles'], types: ['movie'] })); return; }
    res.statusCode = 500; res.end('no');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/${TOKEN}/manifest.json`;
}
const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(DIR, { recursive: true, force: true }); });

/** Run fn with stderr captured (warnings go there), return fn's value and what was written. */
async function stderrOf<T>(fn: () => Promise<T>): Promise<{ v: T; out: string }> {
  const w = process.stderr.write; let out = '';
  process.stderr.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof w;
  try { return { v: await fn(), out }; } finally { process.stderr.write = w; }
}

test('addonOrigin keeps scheme and host only', () => {
  assert.equal(addonOrigin(`https://addon.example.org:8443/${TOKEN}/manifest.json?x=1`), 'https://addon.example.org:8443');
  assert.equal(addonOrigin('not a url'), 'addon');
});

test('a failing manifest logs and reports the origin, never the token in the path', async () => {
  const url = await addon(false);
  const { out } = await stderrOf(() => manifest(url).then(() => assert.fail('should fail'), (e: Error) => {
    assert.ok(!e.message.includes(TOKEN), e.message);
    assert.match(e.message, /^500 .* for http:\/\/127\.0\.0\.1:\d+$/);
  }));
  assert.match(out, /manifest failed/);
  assert.ok(!out.includes(TOKEN), out);
  getState().settings.addons = [url];
  const [info] = await stderrOf(() => listAddons()).then((r) => r.v);
  assert.equal(info.ok, false);
  assert.ok(info.error && !info.error.includes(TOKEN), String(info.error));
  assert.equal(info.name, addonOrigin(url), 'Settings shows the name: the origin, not the URL');
});

test('failing stream and subtitle requests log without the token', async () => {
  getState().settings.addons = [await addon(true)];
  const { v, out } = await stderrOf(async () => ({ streams: await getStreams('movie', 'tt1'), subs: await getAddonSubtitles('movie', 'tt1', {}) }));
  assert.deepEqual(v.streams.failed, ['ProviderA']);
  assert.deepEqual(v.subs, [{ addon: 'ProviderA', subs: [], lan: false }]);
  assert.match(out, /stream addon failed/);
  assert.match(out, /subtitle addon failed/);
  assert.ok(!out.includes(TOKEN), out);
});
