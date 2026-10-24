import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findChosen, rankThen, judge, summarize, readPicks, agreement, gridSearch, casesFrom, reparseCases, tallyOutcomes, outcomeReport, type PickCase } from '../scripts/pick-agreement.ts';
import { pickLine, outcomeLine } from '../server/picks.ts';
import type { PickOutcome } from '../server/types.ts';
import { PICK } from '../server/score.ts';
import type { Source } from '../server/types.ts';

const GB = 1024 ** 3;
const src = (h: string, o: Partial<Source> = {}): Source => ({ id: `${h.repeat(40)}:${o.fileIdx ?? 0}`, infoHash: h.repeat(40), fileIdx: 0, addon: 'Local', releaseName: `Show.S01E01.1080p.WEB-GRP${h}`, seeders: 500, seedersLive: true, sizeBytes: 1 * GB, resolution: '1080p', codec: 'h264', sourceTag: 'WEB', score: 0, warnings: [], ...o });
// Stored in the order the route ranked them then: a, b, c, with Auto then on b.
const kase = (o: Partial<PickCase> = {}): PickCase => ({ videoId: 'tt1:1:1', type: 'series', target: 'browser', how: 'manual', runtimeSec: 2700, chosen: { infoHash: 'c'.repeat(40) }, autoThen: src('b').id,
  sources: [src('a', { seeders: 20, sizeBytes: 4 * GB }), src('b', { seeders: 30 }), src('c', { seeders: 3000 })], ...o });

test('findChosen: by hash, and by file when the case names one', () => {
  const pack = [src('p', { fileIdx: 1 }), src('p', { fileIdx: 4 }), src('q')];
  assert.equal(findChosen({ chosen: { infoHash: 'p'.repeat(40), fileIdx: 4 } }, pack), pack[1]);
  assert.equal(findChosen({ chosen: { infoHash: 'p'.repeat(40) } }, pack), pack[0]);
  assert.equal(findChosen({ chosen: { infoHash: 'p'.repeat(40), fileIdx: 9 } }, pack), pack[0], 'a file the list lacks: the torrent still counts');
  assert.equal(findChosen({ chosen: { infoHash: 'z'.repeat(40) } }, pack), undefined);
});

test('rankThen: the stored order with the stored Auto first; judge: the order server/score.ts gives now', () => {
  assert.equal(rankThen(kase()), 3);
  assert.equal(rankThen(kase({ autoThen: src('c').id })), 1);
  const j = judge(kase());
  assert.equal(j.rank, 1, 'the release with a hundred times the seeders wins now');
  assert.equal(j.auto?.infoHash, 'c'.repeat(40));
  assert.equal(judge(kase({ chosen: { infoHash: 'z'.repeat(40) } })).rank, undefined);
});

test('summarize: top-1, top-3 and mean rank over the cases that have one', () => {
  assert.deepEqual(summarize([1, 2, 5, undefined, 1]), { n: 4, top1: 2, top3: 3, meanRank: 2.25 });
  assert.deepEqual(summarize([]), { n: 0, top1: 0, top3: 0, meanRank: 0 });
});

test('readPicks: picks.jsonl lines as cases; a broken line is skipped', () => {
  const line = { t: 1, videoId: 'tt2', type: 'movie', target: 'chromecast', via: 'play', runtimeSec: 6000, auto: src('a').id, chosen: `${'b'.repeat(40)}:-1`, sources: [src('a'), src('b')].map(({ score: _s, warnings: _w, ...f }) => f) };
  const [c, ...rest] = readPicks(`${JSON.stringify(line)}\n{not json\n\n`);
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...c, sources: c.sources.length }, { videoId: 'tt2', type: 'movie', target: 'chromecast', how: 'log', runtimeSec: 6000, autoThen: src('a').id, chosen: { infoHash: 'b'.repeat(40), fileIdx: undefined }, sources: 2 });
  assert.deepEqual(c.sources[0].warnings, []);
  const [withCaps] = readPicks(JSON.stringify({ ...line, caps: { hevc: true } }));
  assert.deepEqual(withCaps.caps, { hevc: true });
});

test('judge: ranks with the codecs the browser said it decodes', () => {
  const c = kase({ chosen: { infoHash: 'h'.repeat(40) }, sources: [src('a', { seeders: 400, sizeBytes: 2 * GB }), src('h', { codec: 'hevc', seeders: 400, sizeBytes: 2 * GB })] });
  assert.equal(judge(c).rank, 2);
  assert.equal(judge({ ...c, caps: { hevc: true } }).rank, 1);
});

test('agreement and gridSearch: weighted by how the pick was made, a test pick counts for nothing', () => {
  const won = kase(), lost = kase({ chosen: { infoHash: 'a'.repeat(40) } });
  assert.deepEqual(agreement([won, lost]).top1, 0.5);
  assert.equal(agreement([won, { ...lost, how: 'test' }]).top1, 1);
  assert.equal(agreement([won, { ...lost, how: 'same-pack' }]).top1, 1 / 1.5);
  assert.equal(agreement([{ ...won, rejected: ['c'.repeat(40)] }]).rejected, 1);
  const g = gridSearch([won], { halfSeeds: [100, 400], margin: [2] });
  assert.equal(g.length, 2);
  assert.equal(g[0].top1, 1);
  assert.deepEqual(Object.keys(g[0].p).sort(), Object.keys(PICK).sort());
});

test('casesFrom: a collected dataset, a bare list, and the fixture format with "hash:idx" and partial sources', () => {
  assert.deepEqual(casesFrom({ cases: [kase()] }).map((c) => c.chosen), [{ infoHash: 'c'.repeat(40) }]);
  assert.equal(casesFrom([kase(), kase()]).length, 2);
  assert.deepEqual([casesFrom(null), casesFrom({}), casesFrom('x')], [[], [], []]);
  const [a, b] = casesFrom([
    { note: 'a pack file', type: 'series', target: 'browser', runtimeSec: 2700, chosen: `${'p'.repeat(40)}:4`, sources: [{ id: `${'p'.repeat(40)}:4`, infoHash: 'p'.repeat(40), fileIdx: 4, releaseName: 'Show.S01.1080p.WEB.H264-GRP', resolution: '1080p' }] },
    { type: 'movie', target: 'chromecast', chosen: `${'q'.repeat(40)}:-1`, sources: [] },
  ]);
  assert.deepEqual(a.chosen, { infoHash: 'p'.repeat(40), fileIdx: 4 });
  assert.deepEqual([a.videoId, a.note, b.videoId, b.chosen.fileIdx], ['case1', 'a pack file', 'case2', undefined], 'each fixture case counts as a title of its own');
  assert.deepEqual([a.sources[0].addon, a.sources[0].score, a.sources[0].warnings], ['Local', 0, []]);
  assert.equal(findChosen(a, a.sources), a.sources[0]);
});

test('reparseCases: release names read again by the parser as it is now, the stored cases left alone', () => {
  const c = kase({ sources: [src('a', { releaseName: 'Movie 2008 1080p Blu-ray VC 1- GRP', codec: undefined, sourceTag: undefined })] });
  const [r] = reparseCases([c]);
  assert.deepEqual([r.sources[0].codec, r.sources[0].sourceTag, r.sources[0].group, r.sources[0].seeders], ['other', 'BluRay', 'GRP', 500]);
  assert.equal(c.sources[0].codec, undefined);
});

test('the scrubbed fixture measures as score.test.ts checks it: every pick agrees, read as stored or parsed again', () => {
  const cases = casesFrom(JSON.parse(fs.readFileSync(new URL('./fixtures/pick-cases.json', import.meta.url), 'utf8')));
  assert.ok(cases.length >= 5);
  assert.equal(agreement(cases).top1, 1);
  assert.equal(agreement(reparseCases(cases)).top1, 1);
});

test('tallyOutcomes and outcomeReport: what became of the picks played here, per who chose, as server/picks.ts writes them', () => {
  const list = [src('a'), src('b'), src('c')];
  const offer = { videoId: 'tt1:1:1', type: 'series' as const, target: 'browser' as const, auto: list[0].id, sources: list };
  const autoPick = pickLine(offer, list[0].id, 'play', 1000)!;
  const ownerPick = pickLine(offer, list[1].id, 'play', 2000)!;
  const quiet = pickLine(offer, list[0].id, 'play', 3000)!;
  const cast = pickLine(offer, list[2].id, 'cast', 4000)!;
  const old = JSON.stringify({ ...JSON.parse(quiet), t: 500, v: undefined });
  const out = (pickT: number, chosen: string, outcome: PickOutcome, watchedSec: number, t: number) => outcomeLine(pickT, { videoId: 'tt1:1:1', chosen, outcome, pos: 0, watchedSec }, t);
  assert.equal(tallyOutcomes([autoPick, ownerPick].join('\n')), undefined, 'no outcome line yet: nothing to say');
  const text = [old, autoPick, ownerPick, quiet, cast,
    out(1000, list[0].id, 'stall', 120, 1100), out(1000, list[0].id, 'switch', 180, 1200), out(1000, list[0].id, 'stall', 300, 1300),
    out(2000, list[1].id, 'no-peers', 0, 2100),
    out(999, list[2].id, 'stall', 60, 2200),
    '{not json',
  ].join('\n');
  const t = tallyOutcomes(text)!;
  assert.deepEqual(t.Auto, { picks: 2, troubled: 1, kinds: { stall: 1, switch: 1 }, watchedSec: [120] }, 'the old line and the cast are not counted, a stall twice is one');
  assert.deepEqual(t.owner, { picks: 1, troubled: 1, kinds: { 'no-peers': 1 }, watchedSec: [0] }, 'an outcome whose pick was trimmed away is left out');
  assert.deepEqual(outcomeReport(t), [
    '\noutcomes, picks played here since the log learned them:',
    '  Auto   1 of 2 ran into trouble: stall 1, switch 1; median 2 min watched first',
    '  owner  1 of 1 ran into trouble: no-peers 1; median 0 min watched first',
  ]);
  assert.equal(readPicks(text).length, 5, 'outcome lines are not picks');
});
