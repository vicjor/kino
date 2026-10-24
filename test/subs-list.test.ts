import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Torrent } from 'webtorrent';
(await import('../server/config.ts')).ensureDirs();
const { listSubtitles } = await import('../server/subs/index.ts');
const { getState } = await import('../server/store.ts');

const servers: http.Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

test('listSubtitles: a stale answer for the file-name query does not hide what the plain query knows', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval'] });   // opening the file starts a stats ticker this fake torrent never stops
  // Like the OpenSubtitles CDN for a new episode: the URL with the file name still holds its first, partial answer.
  const asked: string[] = [];
  const sub = (lang: string) => ({ id: lang, url: `https://subs.example.org/${lang}.srt`, lang });
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/manifest.json')) { res.end(JSON.stringify({ id: 'os', name: 'OpenSubtitles v3', resources: ['subtitles'], types: ['series'] })); return; }
    asked.push(req.url || '');
    res.end(JSON.stringify({ subtitles: req.url?.includes('filename=') ? [sub('spa'), sub('rus')] : [sub('eng'), sub('spa'), sub('rus')] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  getState().settings.addons = [`http://127.0.0.1:${(srv.address() as AddressInfo).port}/manifest.json`];
  const t = { infoHash: 'f'.repeat(40), files: [{ name: 'Show.S29E02.1080p.mkv', length: 10, progress: 0, select() {}, deselect() {} }] } as unknown as Torrent;

  const tracks = await listSubtitles('series', 'tt0121955:29:2', t, 0);
  assert.deepEqual(tracks.map((x) => x.lang).sort(), ['eng', 'rus', 'spa'], 'merged by URL, no duplicates');
  assert.equal(asked.length, 2, 'asked with and without the file name');
});
