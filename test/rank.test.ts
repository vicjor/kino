import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rankLive } from '../server/rank.ts';
import { setScrapeForTests } from '../server/scrape.ts';
import { headroom } from '../server/score.ts';
import type { Source } from '../server/types.ts';

const GB = 1024 ** 3;
// An addon's figure, not a live count: what getStreams hands over.
const mk = (infoHash: string, o: Partial<Source> = {}): Source => ({ id: `${infoHash}:0`, infoHash, fileIdx: 0, addon: 'T', releaseName: 'Show.S01E02.1080p.WEB-DL.H264-GRP', score: 0, warnings: [], seeders: 100, sizeBytes: 2 * GB, resolution: '1080p', codec: 'h264', sourceTag: 'WEB-DL', ...o });
// Fake trackers: no test here ever asks a public one. Each test uses its own hashes: scrape.ts caches what it heard.
let answer: (hashes: string[]) => Promise<Map<string, number>> = async () => new Map();
setScrapeForTests((hashes) => answer(hashes));
after(() => setScrapeForTests(null));

test('rankLive: live counts replace the addons\' figures before the pick; a hash nobody answers for keeps its figure', async () => {
  const live = new Map([['a1'.repeat(20), 0], ['b2'.repeat(20), 300]]);
  answer = async (hashes) => new Map(hashes.filter((h) => live.has(h)).map((h) => [h, live.get(h)!]));
  const loud = mk('A1'.repeat(20), { seeders: 5000 }), quiet = mk('b2'.repeat(20), { seeders: 40 }), unasked = mk('c3'.repeat(20), { seeders: 60 });
  const { ranked, auto } = await rankLive([loud, quiet, unasked], 'chromecast', 'series');
  assert.equal(auto, quiet, 'the trackers say 300 for it and 0 for the 5000 the addon claimed');
  assert.deepEqual([loud.seeders, loud.seedersLive, loud.seedersAddon], [0, true, 5000]);
  assert.deepEqual([unasked.seeders, unasked.seedersLive], [60, undefined]);
  assert.deepEqual(ranked.map((s) => s.infoHash), [quiet, unasked, loud].map((s) => s.infoHash));
});

test('rankLive: the running time reaches the pick, and the binge group is preferred when it scores close', async () => {
  answer = async () => new Map();
  const big = mk('d4'.repeat(20), { sizeBytes: 3 * GB, seeders: 120 }), small = mk('e5'.repeat(20), { resolution: '720p', sizeBytes: 0.6 * GB, seeders: 120 });
  assert.equal((await rankLive([big, small], 'browser', 'series')).auto, big, 'a typical 45 minute episode: 3 GB streams fine');
  assert.equal((await rankLive([big, small], 'browser', 'series', { runtimeSec: 20 * 60 })).auto, small, 'in 20 minutes it would stop to buffer');
  assert.equal(big.headroom, Math.round(headroom(big, 20 * 60) * 100) / 100);
  const a = mk('f6'.repeat(20), { seeders: 400 }), b = mk('a7'.repeat(20), { seeders: 380, bingeGroup: 'pack' });
  assert.equal((await rankLive([a, b], 'browser', 'series')).auto, a);
  assert.equal((await rankLive([a, b], 'browser', 'series', { binge: 'pack' })).auto, b);
});

test('rankLive: slow or failing trackers cost the pick its live counts, never the wait', async () => {
  answer = () => new Promise(() => undefined);   // never answers
  const s = mk('b8'.repeat(20), { seeders: 70 });
  const t0 = Date.now();
  const { auto } = await rankLive([s], 'browser', 'movie', { seedsWaitMs: 50 });
  assert.ok(Date.now() - t0 < 1000, 'held to the cap');
  assert.equal(auto, s);
  assert.deepEqual([s.seeders, s.seedersLive], [70, undefined], 'the addon\'s figure stands');
  answer = async () => { throw new Error('socket closed'); };
  const f = mk('c9'.repeat(20), { seeders: 80 });
  assert.equal((await rankLive([f], 'browser', 'movie')).auto, f);
  assert.deepEqual([f.seeders, f.seedersLive], [80, undefined]);
});

test('rankLive: what the browser decodes reaches the pick; a TV ranks as before', async () => {
  answer = async () => new Map();
  const h264 = mk('d1'.repeat(20), { seeders: 400 }), hevc = mk('e2'.repeat(20), { codec: 'hevc', seeders: 400 });
  assert.equal((await rankLive([h264, hevc], 'browser', 'series')).auto, h264, 'no caps: HEVC costs a transcode');
  assert.ok(hevc.warnings.includes('HEVC: transcodes in browser'));
  assert.equal((await rankLive([h264, hevc], 'browser', 'series', { caps: { hevc: true } })).auto, hevc, 'decoded: the leaner codec wins on its bits');
  assert.equal(hevc.warnings.length, 0, 'and no transcode warning');
  assert.equal((await rankLive([h264, hevc], 'chromecast', 'series', { caps: { hevc: true } })).auto, h264);
  assert.ok(hevc.warnings.includes('HEVC: will transcode for Chromecast'));
});
