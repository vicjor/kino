import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rankSources, pickAuto, scoreSource, isSeasonPack, headroom, effectiveSeeds, swarmRate, bitrateDoublings, runtimeFor, PICK, RUNTIME_SEC } from '../server/score.ts';
import type { MediaType, Source, Target } from '../server/types.ts';

// Live tracker counts by default: the swarm counts in full.
const mk = (o: Partial<Source>): Source => ({ id: Math.random().toString(36), infoHash: 'x', addon: 'T', releaseName: 'r', score: 0, warnings: [], seeders: 100, seedersLive: true, sizeBytes: 2 * 1024 ** 3, resolution: '1080p', codec: 'h264', sourceTag: 'WEB-DL', ...o });
const GB = 1024 ** 3;
const EPISODE = 45 * 60;

test('auto avoids HEVC for chromecast, prefers it less for browser', () => {
  const h264 = mk({ id: 'a', seeders: 50 });
  const hevc = mk({ id: 'b', codec: 'hevc', seeders: 500 });
  const cc = rankSources([h264, hevc], 'chromecast');
  assert.equal(cc[0].id, 'a');
  assert.ok(cc[1].warnings.some((w) => /transcode/i.test(w)));
});

test('CAM rejected', () => {
  const cam = mk({ id: 'cam', sourceTag: 'CAM', seeders: 9999 });
  const ok = mk({ id: 'ok', seeders: 3, sizeBytes: 0.5 * GB });
  const r = rankSources([cam, ok], 'browser');
  assert.equal(pickAuto(r)!.id, 'ok');
  assert.ok(cam.score < 0);
});

test('4k hevc on chromecast strongly penalised', () => {
  const s = mk({ resolution: '2160p', codec: 'hevc', hdr: 'HDR' });
  scoreSource(s, 'chromecast');
  assert.ok(s.score < 0, `score ${s.score}`);
});

test('binge group preference within tolerance', () => {
  const a = mk({ id: 'a', seeders: 800, bingeGroup: 'g1' });
  const b = mk({ id: 'b', seeders: 400, bingeGroup: 'g2' });
  const r = rankSources([a, b], 'browser');
  assert.equal(pickAuto(r, 'g2')!.id, 'b');
});

test('zero seeders sinks', () => {
  const a = mk({ id: 'a', seeders: 0, resolution: '2160p' });
  const b = mk({ id: 'b', seeders: 5, resolution: '720p', sizeBytes: 0.6 * GB });
  assert.equal(rankSources([a, b], 'browser')[0].id, 'b');
});

test('prefers a small 1080p over a huge remux with more seeds', () => {
  const small = mk({ id: 'small', sizeBytes: 1.4 * GB, seeders: 40, sourceTag: 'WEB-DL' });
  const huge = mk({ id: 'remux', sizeBytes: 22 * GB, seeders: 400, sourceTag: 'REMUX' });
  assert.equal(pickAuto(rankSources([huge, small], 'browser'))?.id, 'small');
});

test('2GB beats 12GB at the same resolution and seeders', () => {
  const lean = mk({ id: 'lean', sizeBytes: 2 * GB, seeders: 50 });
  const fat = mk({ id: 'fat', sizeBytes: 12 * GB, seeders: 50 });
  assert.equal(rankSources([fat, lean], 'browser')[0].id, 'lean');
});

test('a camrip never wins, whoever lists it', () => {
  const cam = mk({ id: 'cam', provider: 'ProviderA', sourceTag: 'CAM', seeders: 900 });
  assert.ok(scoreSource(cam, 'browser') < 0);
});

test('lean HEVC WEB-DL with many seeds beats a 3.9 GB H.264 in the browser', () => {
  const fat = mk({ id: 'fat', sizeBytes: 3.9 * GB, seeders: 234, codec: 'h264', sourceTag: 'WEB-DL' });
  const web = mk({ id: 'web', sizeBytes: 533 * 1024 ** 2, seeders: 83, codec: 'h264', sourceTag: 'WEB' });
  const lean = mk({ id: 'lean', sizeBytes: 971 * 1024 ** 2, seeders: 254, codec: 'hevc', sourceTag: 'WEB-DL' });
  assert.equal(rankSources([fat, web, lean], 'browser')[0].id, 'lean');
  // Chromecast still cannot decode HEVC, so the H.264 stays on top there.
  assert.equal(rankSources([fat, lean], 'chromecast')[0].id, 'fat');
});

test('placeholder seeds score below the same count for real', () => {
  const fake = mk({ id: 'f', provider: 'Tracker', seeders: 100, seedersLive: undefined, seedersEstimated: true, sourceTag: 'WEBRip' });
  const real = mk({ id: 'r', provider: 'Tracker', seeders: 100, sourceTag: 'WEBRip' });
  assert.equal(rankSources([fake, real], 'browser')[0].id, 'r');
  assert.ok(scoreSource(real, 'browser') > scoreSource(fake, 'browser'));
});

test('swarm rate rises with seeders, each one adding less, and levels off at the ceiling', () => {
  const r = [1, 10, 100, 1000, 10000].map((n) => swarmRate(n));
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
  assert.ok(swarmRate(20) - swarmRate(10) > swarmRate(1010) - swarmRate(1000), 'diminishing returns');
  assert.ok(r[4] < PICK.maxRate);
  assert.equal(swarmRate(PICK.halfSeeds), PICK.maxRate / 2);
  assert.equal(swarmRate(0), 0);
});

test('effective seeders: live in full, an addon figure discounted, a placeholder as a modest swarm, none as none', () => {
  assert.equal(effectiveSeeds(mk({ seeders: 200 })), 200);
  assert.equal(effectiveSeeds(mk({ seeders: 200, seedersLive: undefined })), 200 * PICK.addonTrust);
  assert.equal(effectiveSeeds(mk({ seeders: 500, seedersLive: undefined, seedersEstimated: true })), PICK.placeholderSeeds);
  assert.equal(effectiveSeeds(mk({ seeders: 5, seedersLive: undefined, seedersEstimated: true })), 5);
  assert.equal(effectiveSeeds(mk({ seeders: undefined, seedersLive: undefined })), 0);
});

test('headroom: more seeders, a smaller file or a longer running time all help; no seeders is none', () => {
  const room = (o: Partial<Source>, runtime = EPISODE) => headroom(mk(o), runtime);
  assert.ok(room({ seeders: 400 }) > room({ seeders: 40 }));
  assert.ok(room({ sizeBytes: 1 * GB }) > room({ sizeBytes: 4 * GB }));
  assert.ok(room({}, 2 * 3600) > room({}, 22 * 60));
  assert.equal(room({ seeders: 0 }), 0);
  // Just in time: a swarm at half its ceiling delivers exactly the bytes it can in runtime plus prefetch.
  const exact = PICK.maxRate / 2 * (EPISODE + PICK.bufferSec);
  assert.equal(room({ seeders: PICK.halfSeeds, sizeBytes: exact }), 1);
  // A missing size counts as a typical file of its resolution: a 4K one weighs more than a 1080p one.
  assert.ok(room({ sizeBytes: undefined }) > room({ sizeBytes: undefined, resolution: '2160p' }));
});

test('the owner\'s rule: a 3 GB episode is fine with enough seeders, a big file with few loses to a lean one with many', () => {
  const big = (seeders: number) => mk({ id: 'big', sizeBytes: 3.2 * GB, seeders, sourceTag: 'WEB-DL' });
  const lean = mk({ id: 'lean', sizeBytes: 1 * GB, seeders: 150, sourceTag: 'WEBRip' });
  assert.equal(pickAuto(rankSources([big(1500), lean], 'browser', 'series'))!.id, 'big', 'plenty of seeders: the bigger, better file');
  const ranked = rankSources([big(15), lean], 'browser', 'series');
  assert.equal(pickAuto(ranked)!.id, 'lean', 'few seeders for 3 GB: it would stop to buffer');
  assert.ok(ranked.find((s) => s.id === 'big')!.warnings.includes('Few seeders for its size: may stop to buffer'));
  assert.deepEqual(ranked.find((s) => s.id === 'lean')!.warnings, []);
});

test('nothing streams comfortably: the release closest to streaming wins, the hopeless ones fall below zero', () => {
  const r = rankSources([
    mk({ id: '1080', sizeBytes: 2.5 * GB, seeders: 6 }),
    mk({ id: '720', resolution: '720p', sourceTag: 'WEBRip', sizeBytes: 0.6 * GB, seeders: 8 }),
    mk({ id: '4k', resolution: '2160p', codec: 'hevc', sizeBytes: 12 * GB, seeders: 4 }),
  ], 'browser', 'series');
  assert.equal(pickAuto(r)!.id, '720');
  assert.ok(r.every((s) => s.warnings.includes('Few seeders for its size: may stop to buffer')));
  assert.ok(r.find((s) => s.id === '4k')!.score <= 0);
});

test('the running time sets the bitrate a file needs: 4 GB streams for a two hour film, not for a 22 minute episode', () => {
  const s = () => mk({ sizeBytes: 4 * GB, seeders: 120 });
  const film = s(); scoreSource(film, 'browser', 'movie', { runtimeSec: 2 * 3600 });
  const short = s(); scoreSource(short, 'browser', 'series', { runtimeSec: 22 * 60 });
  assert.deepEqual(film.warnings, []);
  assert.deepEqual(short.warnings, ['Few seeders for its size: may stop to buffer']);
  assert.ok(film.headroom! > short.headroom!);
  assert.equal(runtimeFor('movie'), RUNTIME_SEC.movie);
  assert.equal(runtimeFor(undefined), RUNTIME_SEC.series);
  assert.equal(runtimeFor('series', { runtimeSec: 1800 }), 1800);
});

test('quality within a resolution: more bits count a little, up to two doublings either way, HEVC needs fewer', () => {
  const q = (o: Partial<Source>) => bitrateDoublings(mk(o), EPISODE);
  assert.ok(q({ sizeBytes: 3 * GB }) > q({ sizeBytes: 1 * GB }));
  assert.ok(q({ sizeBytes: 1 * GB, codec: 'hevc' }) > q({ sizeBytes: 1 * GB }));
  assert.equal(q({ sizeBytes: undefined }), 0);
  // Small files from a huge swarm all reach the headroom cap, so only the bitrate term differs.
  const at = (gb: number) => { const s = mk({ sizeBytes: gb * GB, seeders: 1e9 }); scoreSource(s, 'browser', 'series'); return s.score; };
  assert.equal(at(1) - at(0.5), PICK.qualityPts, 'one doubling of bitrate');
  assert.equal(at(0.2) - at(0.1), 0, 'past the floor a tinier file loses nothing more');
});

// Scrubbed cases from the owner's own picks (scripts/pick-agreement.ts): what he played is the automatic pick.
test('real picks: the automatic pick is the release the owner chose', () => {
  type Case = { note: string; type: MediaType; target: Target; runtimeSec: number; chosen: string; sources: Partial<Source>[] };
  const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/pick-cases.json', import.meta.url), 'utf8')) as Case[];
  assert.ok(cases.length >= 5);
  for (const c of cases) {
    const ranked = rankSources(c.sources.map((s) => ({ addon: 'Local', score: 0, warnings: [], ...s }) as Source), c.target, c.type, { runtimeSec: c.runtimeSec });
    assert.equal(pickAuto(ranked)?.id, c.chosen, c.note);
  }
});

/** Score a fixture for a target and keep it, so a test can read score and warnings. */
const at = (o: Partial<Source>, target: Target = 'browser') => { const s = mk(o); scoreSource(s, target); return s; };
// No size: no bitrate term, and headroom from a typical file of the resolution. Only the fixed rules differ.
const flat = (o: Partial<Source>, target: Target = 'browser') => at({ sizeBytes: undefined, ...o }, target).score;

test('dub sinks 90 below English, dual audio 30, warnings name the languages', () => {
  const en = at({ id: 'en' });
  const dual = at({ id: 'dual', foreignAudio: 'dual', langs: ['ita'] });
  const dub = at({ id: 'dub', foreignAudio: 'dub', langs: ['fra', 'deu'] });
  assert.equal(en.score - dual.score, 30);
  assert.equal(en.score - dub.score, 90);
  assert.deepEqual(en.warnings, []);
  assert.deepEqual(dual.warnings, ['Dual audio (ITA + EN): check the audio track']);
  assert.deepEqual(dub.warnings, ['FRA/DEU dub, not English']);
  assert.deepEqual(rankSources([dub, dual, en], 'chromecast').map((s) => s.id), ['en', 'dual', 'dub']);
});

test('season pack without a file index loses 30 and says so', () => {
  const single = at({ id: 'single', releaseName: 'Show.2019.1080p.WEB-DL' });
  const pack = at({ id: 'pack', releaseName: 'Show.S02.1080p.WEB-DL' });
  assert.equal(single.score - pack.score, 30);
  assert.deepEqual(pack.warnings, ['Season pack without file index']);
  // A file index or a filename tells Kino which file to play.
  assert.equal(at({ releaseName: 'Show.S02.1080p.WEB-DL', fileIdx: 4 }).score, single.score);
  assert.equal(at({ releaseName: 'Show.S02.1080p.WEB-DL', filename: 'Show.S02E04.mkv' }).score, single.score);
  assert.equal(at({ releaseName: 'Show.S1E4.1080p.WEB-DL' }).score, single.score);
});

test('a single episode is not a season pack', () => {
  const single = at({ releaseName: 'Show.2019.1080p.WEB-DL' });
  assert.equal(at({ releaseName: 'Show.S02E03.1080p.WEB-DL' }).score, single.score);
  assert.equal(at({ releaseName: 'Movie.2019.1080p.BluRay.DTS5.1' }).score, single.score);
  assert.deepEqual(at({ releaseName: 'Show.S02E03.1080p.WEB-DL' }).warnings, []);
});

test('isSeasonPack: a season token on its own, never an episode or an audio tag', () => {
  for (const name of ['Show.S02.1080p.WEB-DL', 'Show S02 Complete 720p', 'Show.S01-S03.1080p', 'Show_S2_1080p', 'show.s02', 'Show.Season.2.1080p', 'Show Seasons 1-3', 'Show.Complete.Series.1080p'])
    assert.equal(isSeasonPack(name), true, name);
  for (const name of ['Show.S02E03.1080p', 'Show.S1E4.720p', 'Show.S02.E03.1080p', 'Show S02 E03', 'Show.S02E03-E04', 'Show.Season.2.Episode.3', 'Movie.2019.1080p.BluRay.DTS5.1', 'Movie.2019.DDP5.1.x265', 'Hunting.Season.2006.1080p', 'Show.Complete.mkv'])
    assert.equal(isSeasonPack(name), false, name);
});

test('a movie with "Season" in its title is never a season pack; a series or an unknown kind still is', () => {
  const film = { releaseName: 'Open.Season.2.2008.1080p.BluRay.x264' };
  const ctx = { runtimeSec: 90 * 60 };   // one running time for all three kinds: only the pack rule differs
  const plain = mk({ releaseName: 'Open.2008.1080p.BluRay.x264' });
  scoreSource(plain, 'browser', 'movie', ctx);
  const movie = mk(film);
  assert.equal(scoreSource(movie, 'browser', 'movie', ctx), plain.score);
  assert.deepEqual(movie.warnings, []);
  for (const kind of ['series', undefined] as const) {
    const s = mk(film);
    assert.equal(plain.score - scoreSource(s, 'browser', kind, ctx), 30, String(kind));
    assert.deepEqual(s.warnings, ['Season pack without file index']);
  }
  // rankSources hands the kind to every source.
  const ranked = rankSources([mk({ id: 'a', ...film }), mk({ id: 'b', releaseName: 'Show.S02.1080p.WEB-DL' })], 'chromecast', 'movie');
  assert.ok(ranked.every((s) => !s.warnings.includes('Season pack without file index')));
  assert.ok(rankSources([mk(film)], 'chromecast', 'series')[0].warnings.includes('Season pack without file index'));
});

test('HD audio costs 5 on Chromecast only', () => {
  const plain = at({ audio: 'AAC' }, 'chromecast');
  for (const audio of ['DTS-HD MA 5.1', 'TrueHD 7.1', 'DDP5.1 Atmos']) {
    const hd = at({ audio }, 'chromecast');
    assert.equal(plain.score - hd.score, 5, audio);
    assert.deepEqual(hd.warnings, ['HD audio: re-encoded to AAC']);
  }
  assert.equal(at({ audio: 'DDP5.1' }, 'chromecast').score, plain.score);
  const browser = at({ audio: 'DTS-HD MA 5.1' });
  assert.equal(browser.score, at({ audio: 'AAC' }).score);
  assert.deepEqual(browser.warnings, []);
});

test('HDR is tone-mapped on every target: 30 on iOS and Chromecast, a transcode in the browser', () => {
  const sdr = at({}, 'ios');
  const dv = at({ hdr: 'DV' }, 'ios');
  assert.equal(sdr.score - dv.score, 30);
  assert.deepEqual(dv.warnings, ['DV: tone-mapped']);
  assert.deepEqual(at({ hdr: 'HDR10' }, 'chromecast').warnings, ['HDR10: tone-mapped']);
  // media/decide.ts transcodes every HDR file in the browser, H.264 too: charged as any transcode there.
  const web = at({ hdr: 'HDR10' });
  assert.equal(at({}).score - web.score, 6);
  assert.deepEqual(web.warnings, ['HDR10: tone-mapped']);
  assert.equal(at({ codec: 'hevc', hdr: 'HDR10' }).score, at({ codec: 'hevc' }).score, 'one transcode, charged once');
});

test('a screen that shows HDR itself (a DLNA TV, caps.hdr) is charged nothing for it; other targets ignore the cap', () => {
  const scored = (o: Partial<Source>, target: Target, caps?: { hevc?: boolean; hdr?: boolean }) => { const s = mk(o); scoreSource(s, target, undefined, { caps }); return s; };
  const tv = scored({ hdr: 'DV' }, 'browser', { hdr: true });
  assert.deepEqual([tv.score, tv.warnings], [scored({}, 'browser').score, []]);
  const hevc = scored({ codec: 'hevc', hdr: 'HDR10' }, 'browser', { hevc: true, hdr: true });
  assert.deepEqual([hevc.score, hevc.warnings], [scored({ codec: 'hevc' }, 'browser', { hevc: true }).score, []]);
  for (const target of ['chromecast', 'ios'] as const) assert.equal(scored({ hdr: 'HDR10' }, target, { hdr: true }).score, scored({ hdr: 'HDR10' }, target).score, target);
  // An H.264 HDR release and its SDR twin: the browser takes the SDR one, the TV either, on its seeders.
  const pair = () => [mk({ id: 'hdr', hdr: 'HDR10', seeders: 120 }), mk({ id: 'sdr', seeders: 100 })];
  assert.equal(rankSources(pair(), 'browser', 'series')[0].id, 'sdr');
  assert.equal(rankSources(pair(), 'browser', 'series', { caps: { hdr: true } })[0].id, 'hdr');
});

test('HEVC and AV1 cost most on Chromecast, less on iOS, little in the browser', () => {
  const cost = (codec: Source['codec'], target: Target) => flat({}, target) - flat({ codec }, target);
  assert.equal(cost('hevc', 'chromecast'), 70);
  assert.equal(cost('hevc', 'ios'), 25);
  assert.equal(cost('av1', 'browser'), 6);
  assert.deepEqual(at({ codec: 'hevc' }, 'ios').warnings, ['HEVC: may transcode']);
  assert.deepEqual(at({ codec: 'av1' }, 'browser').warnings, ['AV1: transcodes in browser']);
  assert.deepEqual(at({ codec: 'av1' }, 'chromecast').warnings, ['AV1: will transcode for Chromecast']);
});

test('a browser that decodes HEVC or AV1 is charged no transcode for it; Chromecast and iOS are, whatever caps say', () => {
  const ctx = (caps: { hevc?: boolean; av1?: boolean }) => ({ caps });
  const scored = (o: Partial<Source>, target: Target, caps: { hevc?: boolean; av1?: boolean } = {}) => { const s = mk({ sizeBytes: undefined, ...o }); scoreSource(s, target, undefined, ctx(caps)); return s; };
  const both = { hevc: true, av1: true };
  for (const codec of ['hevc', 'av1'] as const) {
    const free = scored({ codec }, 'browser', { [codec]: true });
    assert.equal(free.score, scored({ codec }, 'browser').score + 6, codec);
    assert.deepEqual(free.warnings, [], codec);
    assert.equal(scored({ codec }, 'browser', both).score, flat({}), `${codec} decoded scores as H.264 would (no size, so no bitrate term)`);
  }
  // Only the codec the browser names: AV1 caps say nothing about HEVC.
  assert.deepEqual(scored({ codec: 'hevc' }, 'browser', { av1: true }).warnings, ['HEVC: transcodes in browser']);
  assert.deepEqual(scored({ codec: 'av1' }, 'browser', { hevc: true }).warnings, ['AV1: transcodes in browser']);
  // HDR is tone-mapped, so that file transcodes in any browser.
  assert.deepEqual(scored({ codec: 'hevc', hdr: 'HDR10' }, 'browser', both).warnings, ['HDR10: tone-mapped']);
  assert.deepEqual(scored({ codec: 'hevc', hdr: 'HDR10' }, 'browser').warnings, ['HEVC: transcodes in browser']);
  assert.equal(scored({ codec: 'hevc', hdr: 'HDR10' }, 'browser', both).score, scored({ codec: 'hevc', hdr: 'HDR10' }, 'browser').score);
  // Other targets ignore caps: the old Chromecast decodes H.264 only, iOS is judged as before.
  for (const target of ['chromecast', 'ios'] as const) for (const codec of ['hevc', 'av1'] as const) {
    const withCaps = scored({ codec }, target, both), without = scored({ codec }, target);
    assert.deepEqual([withCaps.score, withCaps.warnings], [without.score, without.warnings], `${target} ${codec}`);
  }
  // rankSources hands the caps to every source: a lean HEVC file the browser decodes now wins on its bits.
  const h264 = mk({ id: 'h264', sizeBytes: 2 * GB, seeders: 400 }), hevc = mk({ id: 'hevc', codec: 'hevc', sizeBytes: 2 * GB, seeders: 400 });
  assert.equal(rankSources([h264, hevc], 'browser', 'series')[0].id, 'h264');
  assert.equal(rankSources([h264, hevc], 'browser', 'series', { caps: { hevc: true } })[0].id, 'hevc');
});

test('4K HEVC on Chromecast: every reason is listed', () => {
  const s = at({ resolution: '2160p', codec: 'hevc', hdr: 'HDR', seeders: 1000, sizeBytes: 8 * GB }, 'chromecast');
  assert.deepEqual(s.warnings, ['HEVC: will transcode for Chromecast', 'HDR: tone-mapped', '4K HEVC: too heavy to transcode']);
  assert.deepEqual(at({ resolution: '2160p', codec: 'av1', seeders: 1000, sizeBytes: 8 * GB }, 'chromecast').warnings, ['AV1: will transcode for Chromecast', '4K AV1: too heavy to transcode']);
  // 4K costs 20 off the browser, plus 100 more when it is HEVC on Chromecast.
  assert.equal(at({ resolution: '2160p' }).score - at({ resolution: '2160p' }, 'ios').score, 20);
  assert.equal(flat({ resolution: '2160p', codec: 'hevc' }, 'ios') - flat({ resolution: '2160p', codec: 'hevc' }, 'chromecast'), 145);
});

test('source tags and resolutions add fixed amounts; CAM and TS are out; a remux over 25 GB loses 40 more', () => {
  const tag = (sourceTag?: string) => flat({ sourceTag }) - flat({ sourceTag: undefined });
  assert.deepEqual([undefined, 'HDTV', 'REMUX', 'WEBRip', 'WEB', 'BluRay', 'WEB-DL'].map(tag), [0, 2, 5, 10, 10, 15, 18]);
  const big = (sourceTag: string) => at({ sourceTag, sizeBytes: 30 * GB, seeders: 1e9 }).score;
  assert.equal(big('BluRay') - big('REMUX'), 10 + 40);
  assert.ok(flat({ sourceTag: 'TS' }) < -900);
  assert.deepEqual(at({ sourceTag: 'TS', seeders: 0 }).warnings, ['Camrip / telesync', 'No seeders reported']);
  // Each resolution at its typical size from a huge swarm: 1080p first, 720p ahead of a 4K file several times its size.
  const res = (resolution: Source['resolution']) => mk({ id: resolution, resolution, sourceTag: undefined, sizeBytes: undefined, seeders: 1e9 });
  assert.deepEqual(rankSources((['480p', '2160p', 'other', '720p', '1080p'] as const).map(res), 'browser').map((s) => s.id), ['1080p', '720p', '2160p', 'other', '480p']);
});

test('seeds: missing counts are none, a placeholder counts as a modest swarm', () => {
  assert.deepEqual(at({ seeders: undefined, seedersLive: undefined }).warnings, ['No seeders reported']);
  assert.deepEqual(at({ seeders: undefined, seedersLive: undefined, seedersEstimated: true }).warnings, ['No seeders reported']);
  assert.equal(at({ seeders: 500, seedersLive: undefined, seedersEstimated: true }).score, at({ seeders: PICK.placeholderSeeds }).score);
  assert.ok(at({ seeders: 0 }).score < at({ seeders: 5 }).score);
});

test('equal scores fall back to the larger seeder count', () => {
  const a = mk({ id: 'a', seeders: 60, seedersLive: undefined, seedersEstimated: true });
  const b = mk({ id: 'b', seeders: 500, seedersLive: undefined, seedersEstimated: true });
  assert.deepEqual(rankSources([a, b], 'browser').map((s) => s.id), ['b', 'a']);
  const none = mk({ id: 'none', seeders: undefined });
  const zero = mk({ id: 'zero', seeders: 0 });
  assert.deepEqual(rankSources([none, zero], 'browser').map((s) => s.id), ['none', 'zero']);
  assert.equal(none.score, zero.score);
  assert.deepEqual(rankSources([zero, none], 'browser').map((s) => s.id), ['zero', 'none']);
});

test('pickAuto: nothing playable falls back to the top row, binge group only within 25 points', () => {
  assert.equal(pickAuto([]), undefined);
  const cams = rankSources([mk({ id: 'c1', sourceTag: 'CAM' }), mk({ id: 'c2', sourceTag: 'TS', seeders: 0 })], 'browser');
  assert.equal(pickAuto(cams)!.id, 'c1');
  const best = mk({ id: 'best', seeders: 800 });
  const far = mk({ id: 'far', seeders: 5, sizeBytes: 12 * GB, bingeGroup: 'g' });
  const r = rankSources([best, far], 'browser');
  assert.ok(r[0].score - far.score > 25);
  assert.equal(pickAuto(r, 'g')!.id, 'best');
  assert.equal(pickAuto(r, 'missing')!.id, 'best');
});
