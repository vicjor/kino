import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type WebTorrent from 'webtorrent';
import express from 'express';
import type { HlsSession } from '../server/media/hls.ts';
// test/setup.ts points KINO_DATA at a temp dir before any of these load.
(await import('../server/config.ts')).ensureDirs();
const store = await import('../server/store.ts');
const torrent = await import('../server/torrent.ts');
const { serveFile, TRANSCODER_SRC } = await import('../server/media/range.ts');
const { ffmpegArgs } = await import('../server/media/hls.ts');
const { watching, isBusy } = await import('../server/health.ts');
store.load();
store.update((s) => { s.settings.minFreeBytes = 0; });

// A fake webtorrent client: nothing here joins a swarm. Its one file streams 16 bytes and then nothing, never ending,
// like a read whose ffmpeg is frozen (SIGSTOP): the connection stays open and nobody drains it.
const file = {
  name: 'Movie.mkv', path: 'Movie.mkv', length: 1_000_000, progress: 0, downloaded: 0, select() {}, deselect() {},
  createReadStream: () => { const r = new Readable({ read() {} }); r.push(Buffer.alloc(16)); return r; },
};
class FakeTorrent extends EventEmitter {
  files: typeof file[] = []; destroyed = false; name = 'Movie.mkv'; magnetURI = '';
  constructor(public infoHash: string) { super(); }
  destroy(_o?: unknown, cb?: () => void) { this.destroyed = true; if (cb) setImmediate(cb); }
}
const add = (magnet: string) => { const t = new FakeTorrent(torrent.infoHashOf(magnet)!); queueMicrotask(() => { t.files = [file]; t.emit('metadata'); }); return t; };
torrent.setClientForTests({ add, destroy: (cb?: () => void) => cb?.() } as unknown as WebTorrent);

const H = 'e'.repeat(40);
const app = express();
app.all('/api/file/:infoHash/:idx', (req, res) => serveFile(req, res, torrent.getTorrent(req.params.infoHash)!, Number(req.params.idx)));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const fileUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file/${H}/0`;
after(async () => { server.closeAllConnections(); server.close(); await torrent.remove(H); torrent.setClientForTests(null); store.flushSync(); });

/** An HLS session reading `sourceUrl`, as play and cast start one. */
const session = (sourceUrl: string): HlsSession => ({
  id: 'x', infoHash: H, fileIdx: 0, sourceUrl, dir: '/hls/x', startOffset: 0, requestedOffset: 0, lastAccess: 0, state: 'ready',
  decision: { mode: 'hls-copy', videoCopy: true, audioCopy: true, segment: 'fmp4', audioIndex: 1 },
  probe: { container: 'mkv', duration: 100, audio: [], subs: [], video: { codec: 'h264', width: 1920, height: 1080 } },
});
/** Start a GET and hold it open: the response is resolved (headers in), its body never read. */
async function hold(url: string) {
  const ac = new AbortController();
  const r = await fetch(url, { signal: ac.signal });
  assert.equal(r.status, 200);
  return () => ac.abort();
}
async function until(ok: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !ok();) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
/** /health's numbers right now, with these HLS sessions. */
const health = (sessions: { parked?: boolean }[]) => watching({ openStreams: torrent.openStreams(), transcoderStreams: torrent.transcoderStreams(), held: 0, sessions, cast: false });

test('ffmpeg reads the file with the transcoder tag; a parked session holding that read open leaves /health idle', async () => {
  await torrent.ensure(H);
  const input = (url: string) => { const a = ffmpegArgs(session(url), { hw: false }); return new URL(a[a.indexOf('-i') + 1]); };
  const src = input(fileUrl);
  assert.equal(src.searchParams.get('src'), TRANSCODER_SRC, 'ffmpeg -i carries the tag serveFile reads');
  assert.equal(input(`${fileUrl}?x=1`).search, `?x=1&src=${TRANSCODER_SRC}`, 'appended to a query');


  const stopFfmpeg = await hold(src.href);
  assert.equal(torrent.openStreams(), 1, 'the read keeps the file open (selected, never evicted)');
  assert.equal(torrent.transcoderStreams(), 1);
  const parked = health([{ parked: true }]);
  assert.deepEqual(parked, { streams: 0, hlsSessions: 0, cast: false }, 'parked: streams 0');
  assert.equal(isBusy(parked), false);
  assert.deepEqual(health([{}]), { streams: 0, hlsSessions: 1, cast: false }, 'running: one session, not a stream too');

  const stopViewer = await hold(fileUrl);   // a browser playing the raw file meanwhile
  assert.equal(torrent.openStreams(), 2);
  assert.equal(health([{ parked: true }]).streams, 1, 'an untagged read is a viewer');
  assert.equal(isBusy(health([{ parked: true }])), true);

  stopViewer(); stopFfmpeg();
  await until(() => torrent.openStreams() === 0);
  assert.equal(torrent.transcoderStreams(), 0, 'closed: no transcoder read left');
});

test('remove forgets the transcoder reads with the rest; a late close from the old load changes nothing', async () => {
  const t = await torrent.ensure(H);
  torrent.openFile(t, 0, 'transcoder');
  await torrent.remove(H);
  assert.equal(torrent.transcoderStreams(), 0);
  const t2 = await torrent.ensure(H);   // played again
  torrent.openFile(t2, 0, 'transcoder');
  torrent.closeFile(t, 0, 'transcoder');   // the old ffmpeg's read ends late
  assert.equal(torrent.transcoderStreams(), 1, 'the new load keeps its count');
  torrent.closeFile(t2, 0, 'transcoder');
  assert.equal(torrent.transcoderStreams(), 0);
  assert.equal(torrent.openStreams(), 0);
});
