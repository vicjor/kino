import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { orphanTranscoders, runShutdown, bounded, stopOnShutdown, type ShutdownSteps } from '../server/lifecycle.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const HLS = '/Users/me/Library/Application Support/Kino/data/hls';
const BIN = '/opt/homebrew/bin/ffmpeg';
const ff = (dir: string) => `-hide_banner -loglevel error -nostdin -y -i http://127.0.0.1:1234/api/file/abc/0 -f hls -hls_segment_filename ${dir}/seg%05d.ts ${dir}/index.m3u8`;

test('orphanTranscoders: only ffmpegs launchd adopted that write under this HLS folder', () => {
  const ps = [
    `  101     1 ${BIN} ${ff(`${HLS}/ab12`)}`,                                  // a dead Kino's transcoder
    `  102  4242 ${BIN} ${ff(`${HLS}/cd34`)}`,                                  // a live Kino's own child
    `  103     1 ${BIN} ${ff('/Users/me/kino-dev/hls/ef56')}`,                  // another install's folder
    `  104     1 ${BIN} ${ff(`${HLS}-old/gh78`)}`,                              // a sibling folder sharing the prefix
    `  105     1 /bin/rm -rf ${HLS}/ab12`,                                      // not ffmpeg
    `  106     1 /Applications/Kino.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg ${ff(`${HLS}/ij90`)}`,
    `  107     1 /usr/local/bin/ffmpeg-wrapper ${ff(`${HLS}/kl12`)}`,           // a name that only starts with ffmpeg
    '', 'garbage line',
  ].join('\n');
  assert.deepEqual(orphanTranscoders(ps, HLS), [101, 106]);
  assert.deepEqual(orphanTranscoders(ps, `${HLS}/`), [101, 106]);
  assert.deepEqual(orphanTranscoders('', HLS), []);
});

/** Fake steps that log what ran; cast and torrent default to instant. */
function steps(calls: string[], over: Partial<ShutdownSteps> = {}): ShutdownSteps {
  return {
    flush: () => { calls.push('flush'); },
    now: [['hls', () => { calls.push('hls'); }], ['live', () => { calls.push('live'); }]],
    cast: async () => { calls.push('cast'); },
    torrent: async () => { calls.push('torrent'); },
    closeHttp: () => { calls.push('http'); },
    ...over,
  };
}
const later = (ms: number, fn: () => void) => new Promise<void>((r) => setTimeout(() => { fn(); r(); }, ms));

// The first shutdown of this file: stopOnShutdown registers only until one begins.
test('runShutdown: state first, synchronous stops, the registered ones, the TV, torrents, connections, state again', async () => {
  const calls: string[] = [];
  stopOnShutdown('upnext', () => { calls.push('old upnext'); });
  stopOnShutdown('upnext', () => { calls.push('upnext'); });   // one name holds one stop: the latest
  stopOnShutdown('broken', () => { throw new Error('boom'); });   // logged, the rest still run
  stopOnShutdown('timer', () => { calls.push('timer'); });
  const w = process.stderr.write; process.stderr.write = (() => true) as typeof w;
  try { await runShutdown(steps(calls)); } finally { process.stderr.write = w; }
  assert.deepEqual(calls, ['flush', 'hls', 'live', 'upnext', 'timer', 'cast', 'torrent', 'http', 'flush']);
  stopOnShutdown('late', () => { calls.push('late'); });
  assert.equal(calls.at(-1), 'late', 'a stop registered once the shutdown began runs at once');
});

test('runShutdown: a step that throws or rejects is skipped, the rest still run', async () => {
  const calls: string[] = [];
  await runShutdown(steps(calls, {
    now: [['boom', () => { throw new Error('sync'); }], ['live', () => { calls.push('live'); }]],
    cast: () => Promise.reject(new Error('no TV')),
    torrent: () => { throw new Error('thrown before any promise'); },
  }));
  assert.deepEqual(calls, ['flush', 'live', 'http', 'flush']);
});

test('runShutdown: a TV and a torrent client that never answer cost their budget, not the exit', async () => {
  const calls: string[] = [];
  const t0 = Date.now();
  await runShutdown(steps(calls, { cast: () => new Promise(() => {}), torrent: () => new Promise(() => {}) }), { castMs: 50, totalMs: 150 });
  const ms = Date.now() - t0;
  assert.deepEqual(calls, ['flush', 'hls', 'live', 'http', 'flush']);
  assert.ok(ms >= 140 && ms < 1000, `took ${ms} ms`);
});

test('runShutdown: the torrent client gets what the TV left of the total', async () => {
  const calls: string[] = [];
  await runShutdown(steps(calls, {
    cast: () => later(150, () => calls.push('cast')),
    torrent: () => later(250, () => calls.push('torrent')),   // would finish at 400 ms, the total is 200
  }), { castMs: 1000, totalMs: 200 });
  assert.deepEqual(calls, ['flush', 'hls', 'live', 'cast', 'http', 'flush']);
});

test('bounded: settles with the step or at the timeout, never throws', async () => {
  let done = false;
  await bounded('fast', () => later(10, () => { done = true; }), 1000);
  assert.equal(done, true);
  const t0 = Date.now();
  await bounded('stuck', () => new Promise(() => {}), 30);
  assert.ok(Date.now() - t0 < 500);
  await bounded('negative budget', () => new Promise(() => {}), -5);
  await bounded('rejects', () => Promise.reject(new Error('x')), 1000);
});

// desktop/main.cjs checks for the export at runtime and quits at once without it, so a rename would go unnoticed.
test('the desktop app quits through the server module\'s exported shutdown', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'server/index.ts'), 'utf8'), /^export function shutdown\(/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8'), /server\.shutdown\('quit'\)/);
});
