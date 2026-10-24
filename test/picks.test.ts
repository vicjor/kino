import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remember, record, recordOutcome, outcomeLine, isOutcome, scrub, features, pickLine, trimLines, MAX_BYTES, OUTCOME_HOURS } from '../server/picks.ts';
import type { Source } from '../server/types.ts';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-picks-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const mk = (n: number, o: Partial<Source> = {}): Source => ({ id: `${String(n).repeat(40).slice(0, 40)}:0`, infoHash: String(n).repeat(40).slice(0, 40), fileIdx: 0, addon: 'Local', provider: 'ProviderA', releaseName: `Show.S01E02.1080p.WEB.H264-GRP${n}`, seeders: 100 * n, seedersLive: true, sizeBytes: n * 1024 ** 3, resolution: '1080p', codec: 'h264', sourceTag: 'WEB', bingeGroup: 'g', score: 120 - n, headroom: 3, warnings: ['x'], ...o });
const offer = (sources: Source[]) => ({ videoId: 'tt1:1:2', type: 'series' as const, target: 'browser' as const, runtimeSec: 2700, auto: sources[0]?.id, sources });

test('scrub: links and bracketed site tags go, the release itself stays', () => {
  assert.equal(scrub('Show S01E02 1080p WEB H264-GRP[site.to]'), 'Show S01E02 1080p WEB H264-GRP');
  assert.equal(scrub('Film.2026.1080p.WEBRip.x264.AAC5.1-[SITE.GG - SITE.BZ].mp4'), 'Film.2026.1080p.WEBRip.x264.AAC5.1-.mp4');
  assert.equal(scrub('www.site.example - Show S02E01.mkv'), '- Show S02E01.mkv');
  assert.equal(scrub('Show [ Site.me ] S01E01 https://x.example/a?token=1 end'), 'Show S01E01 end');
  for (const keep of ['Show [1080p.WEB-DL.H265.EAC3.5.1-GRP]', 'Show [HDTV 1080p][Cap.406]', 'Show.S01.DDP5.1-GRP[XyZ]'])
    assert.equal(scrub(keep), keep, keep);
});

test('features: what the scorer reads, nothing else; names scrubbed', () => {
  const f = features(mk(1, { releaseName: 'Show.S01E02-GRP[site.to]', filename: 'www.site.example Show.mkv' }));
  assert.deepEqual(Object.keys(f).sort(), ['codec', 'fileIdx', 'filename', 'id', 'infoHash', 'provider', 'releaseName', 'resolution', 'seeders', 'seedersLive', 'sizeBytes', 'sourceTag'].sort());
  assert.equal(f.releaseName, 'Show.S01E02-GRP');
  assert.equal(f.filename, 'Show.mkv');
});

test('pickLine: the title, Auto, the chosen release and the best ranked candidates, the chosen one always in', () => {
  const list = Array.from({ length: 45 }, (_, i) => mk(i + 1));
  const far = list[44];
  const line = JSON.parse(pickLine(offer(list), far.id, 'play', 1234)!);
  assert.deepEqual({ ...line, sources: line.sources.length }, { t: 1234, v: 2, videoId: 'tt1:1:2', type: 'series', target: 'browser', via: 'play', runtimeSec: 2700, auto: list[0].id, chosen: far.id, sources: 41 });
  assert.equal(line.sources.at(-1).id, far.id);
  assert.equal(pickLine(offer(list), 'f'.repeat(40) + ':0', 'play'), undefined, 'not on the list');
  // What a browser said it decodes reached the ranking, so the line keeps it.
  assert.deepEqual(JSON.parse(pickLine({ ...offer(list), caps: { hevc: true } }, far.id, 'play')!).caps, { hevc: true });
});

test('trimLines: keeps the newest whole lines within half the limit', () => {
  const text = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30)].map((l) => `${l}\n`).join('');
  assert.equal(trimLines(text, 130), `${'c'.repeat(30)}\n${'d'.repeat(30)}\n`);
  assert.equal(trimLines(text, 10), '');
  assert.equal(trimLines('', 100), '');
});

test('record: appends a line for a remembered list, nothing for a forgotten one, and never outgrows the limit', () => {
  const file = path.join(DIR, 'picks.jsonl');
  const key = remember(offer([mk(1), mk(2)]));
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.equal(record(key, mk(2).id, 'cast', file), true);
  assert.equal(record('000000000000', mk(2).id, 'play', file), false);
  assert.equal(record(key, mk(3).id, 'play', file), false);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).via, 'cast');
  // Fill it past the limit: the oldest lines go, the newest stay.
  const big = remember(offer(Array.from({ length: 40 }, (_, i) => mk(i + 1, { releaseName: `Show.S01E02.${'x'.repeat(400)}` }))));
  let n = 0;
  while (fs.statSync(file).size <= MAX_BYTES / 2 && n < 10_000) { record(big, mk(1).id, 'play', file); n++; }
  for (let i = 0; i < n * 2; i++) record(big, mk(1).id, 'play', file);
  assert.ok(fs.statSync(file).size <= MAX_BYTES, `${fs.statSync(file).size} bytes`);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('}\n'), 'whole lines only');
});

test('remember: only the latest answers are kept', () => {
  const first = remember(offer([mk(1)]));
  for (let i = 0; i < 60; i++) remember(offer([mk(2)]));
  assert.equal(record(first, mk(1).id, 'play', path.join(DIR, 'old.jsonl')), false);
});

test('outcomeLine: ids and whole seconds, tied to its pick by pickT, nothing else', () => {
  const line = JSON.parse(outcomeLine(5000, { videoId: 'tt1:1:2', chosen: mk(2).id, outcome: 'stall', pos: 612.4, watchedSec: 30.6 }, 6000));
  assert.deepEqual(line, { t: 6000, outcome: 'stall', videoId: 'tt1:1:2', chosen: mk(2).id, pickT: 5000, pos: 612, watchedSec: 31 });
  for (const bad of [undefined, -5, NaN, Infinity]) {
    const l = JSON.parse(outcomeLine(1, { videoId: 'tt1', chosen: mk(1).id, outcome: 'switch', pos: bad, watchedSec: bad }, 2));
    assert.deepEqual([l.pos, l.watchedSec], [0, 0], String(bad));
  }
});

test('isOutcome: the kinds the player reports, nothing else', () => {
  for (const k of ['stall', 'switch', 'no-peers', 'unreadable', 'ended-early']) assert.equal(isOutcome(k), true, k);
  for (const k of ['', 'toString', 'disk-full', 1, null, undefined]) assert.equal(isOutcome(k), false, String(k));
});

test('recordOutcome: one line per kind for a release picked lately, tied to its pick; nothing for one no pick names', () => {
  const file = path.join(DIR, 'outcomes.jsonl');
  const key = remember({ ...offer([mk(1), mk(2)]), videoId: 'tt9:1:1' });
  assert.equal(record(key, mk(2).id, 'play', file, 5000), true);
  const r = { videoId: 'tt9:1:1', chosen: mk(2).id, outcome: 'stall' as const, pos: 612.4, watchedSec: 30.6 };
  assert.equal(recordOutcome(r, file, 6000), true);
  assert.equal(recordOutcome({ ...r, pos: 900 }, file, 7000), false, 'that kind is in already');
  assert.equal(recordOutcome({ ...r, outcome: 'switch', pos: 950, watchedSec: 300 }, file, 8000), true);
  assert.equal(recordOutcome({ ...r, chosen: mk(1).id }, file, 8000), false, 'not the release picked');
  assert.equal(recordOutcome({ ...r, videoId: 'tt9:1:2' }, file, 8000), false, 'another episode of the same release');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].t, 5000);
  assert.deepEqual(lines.slice(1), [
    { t: 6000, outcome: 'stall', videoId: 'tt9:1:1', chosen: mk(2).id, pickT: 5000, pos: 612, watchedSec: 31 },
    { t: 8000, outcome: 'switch', videoId: 'tt9:1:1', chosen: mk(2).id, pickT: 5000, pos: 950, watchedSec: 300 },
  ]);
  // Hours later the trouble is not the pick's any more; a new pick of the same release starts over.
  const late = 5000 + OUTCOME_HOURS * 3600_000 + 1;
  assert.equal(recordOutcome({ ...r, outcome: 'no-peers' }, file, late), false);
  assert.equal(record(key, mk(2).id, 'play', file, late), true);
  assert.equal(recordOutcome(r, file, late + 1), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)!).pickT, late);
});
