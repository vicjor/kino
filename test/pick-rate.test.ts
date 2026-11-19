import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleRate, type Look, type RateOpts } from '../server/pick-rate.ts';

/** A fake clock: waiting moves it on, and `looks` answers by the time it is. */
function run(looks: (ms: number) => Look | undefined, more: Partial<RateOpts> = {}) {
  let ms = 0;
  const o: RateOpts = { windowMs: 60_000, waitMs: 10_000, tickMs: 2000, wait: async (d) => { ms += d; }, now: () => ms, torrents: () => 1, ...more };
  return sampleRate(() => looks(ms), o);
}
const MB = 1024 ** 2;

test('sampleRate: bytes of the file gained over the minute after the metadata came', async () => {
  // Metadata at 4 s, then 2 MB a second.
  const s = await run((ms) => (ms < 4000 ? { ready: false, downloaded: 0, length: 0, numPeers: 3 } : { ready: true, downloaded: (ms - 4000) / 1000 * 2 * MB + MB, length: 1000 * MB, numPeers: 25 }));
  assert.deepEqual(s, { bytes: 120 * MB, sec: 60, peers: 25, haveAtStart: MB, length: 1000 * MB, torrents: 1 });
});

test('sampleRate: nothing when the metadata never comes, the file is on disk, or the torrent goes away', async () => {
  assert.equal(await run(() => undefined), undefined);
  assert.equal(await run(() => ({ ready: false, downloaded: 0, length: 0, numPeers: 0 })), undefined);
  assert.equal(await run(() => ({ ready: true, downloaded: 990 * MB, length: 1000 * MB, numPeers: 9 })), undefined, 'cached already');
  assert.equal(await run((ms) => (ms === 0 ? { ready: true, downloaded: 0, length: MB, numPeers: 1 } : undefined)), undefined, 'gone before the minute was up');
});
