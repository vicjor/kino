import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStream, parseCodec, parseSize, parseGroup, parseAudio, parseSourceTag, sourceTagOf, stripFileExt, flagPlaceholderSeeds, applyLiveSeeds, parseLangs, reparse } from '../server/parse.ts';
import type { Source } from '../server/types.ts';

// Made-up names only: no real title, release group, tracker or site.
const FIXED = 'ProviderF';

const t = (name: string, title: string, extra: Record<string, unknown> = {}) =>
  parseStream({ name, title, infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', ...extra }, 'Addon')!;
const tagOf = (release: string, filename?: string) =>
  parseStream({ name: 'Addon\n1080p', title: `${release}\n👤 12 💾 1.2 GB ⚙️ ProviderA`, infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', behaviorHints: filename ? { filename } : undefined }, 'Addon')!.sourceTag;

test('ALPHA movie', () => {
  const s = t('Addon\n1080p', 'Desert.Saga.Part.Two.2024.1080p.BluRay.x264-ALPHA\n👤 1203 💾 2.53 GB ⚙️ ALPHA');
  assert.equal(s.provider, 'ALPHA');
  assert.equal(s.seeders, 1203);
  assert.equal(s.sizeBytes, Math.round(2.53 * 1024 ** 3));
  assert.equal(s.resolution, '1080p');
  assert.equal(s.codec, 'h264');
  assert.equal(s.sourceTag, 'BluRay');
  assert.equal(s.group, 'ALPHA');
  assert.equal(s.infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
});

test('4k HDR HEVC remux', () => {
  const s = t('Addon\n4k', 'Big.Film.2023.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-GRP\n👤 54 💾 78.2 GB ⚙️ GAMMA', { behaviorHints: { bingeGroup: 'addon|4k|BluRay REMUX|hevc|HDR' } });
  assert.equal(s.resolution, '2160p');
  assert.equal(s.codec, 'hevc');
  assert.equal(s.hdr, 'HDR');
  assert.equal(s.sourceTag, 'REMUX');
  assert.match(s.audio!, /DTS-HD/);
  assert.equal(s.provider, 'GAMMA');
});

test('series in season pack with filename line', () => {
  const s = t('Addon\n1080p', 'Some.Show.S01.1080p.BluRay.x265-BETA\nSome.Show.S01E01.1080p.BluRay.x265-BETA.mkv\n👤 88 💾 12.1 GB ⚙️ BETA', { fileIdx: 0 });
  assert.equal(s.filename, 'Some.Show.S01E01.1080p.BluRay.x265-BETA.mkv');
  assert.equal(s.releaseName, 'Some.Show.S01.1080p.BluRay.x265-BETA');
  assert.equal(s.codec, 'hevc');
  assert.equal(s.fileIdx, 0);
});

test('behaviorHints.filename wins', () => {
  const s = t('Addon\n720p', 'Show.S02E03.720p.WEB.h264-GRPX\n👤 10 💾 800 MB ⚙️ DELTA', { fileIdx: 3, behaviorHints: { filename: 'Show.S02E03.mkv' } });
  assert.equal(s.filename, 'Show.S02E03.mkv');
  assert.equal(s.sourceTag, 'WEB');
  assert.equal(s.provider, 'DELTA');
  assert.equal(s.sizeBytes, 800 * 1024 ** 2);
});

test('CAM detected', () => {
  assert.equal(parseSourceTag('Movie.2025.1080p.HDTS.x264'), 'TS');
  assert.equal(parseSourceTag('Movie.2025.CAMRip.XviD'), 'CAM');
  assert.equal(parseSourceTag('Movie.2025.1080p.WEB-DL.DDP5.1.H.264'), 'WEB-DL');
});

test('a .ts file extension is not telesync, a TS in the release name still is', () => {
  assert.equal(parseSourceTag('Show.S01E01.1080p.x264-GRP.ts'), undefined);
  assert.equal(parseSourceTag('Show S01E01 1080p x264-GRP Show.S01E01.1080p.WEB-DL.x264-GRP.ts'), 'WEB-DL');
  assert.equal(parseSourceTag('Show.S01E01.1080p.x264-GRP.m2ts'), undefined);
  assert.equal(parseSourceTag('Movie.2025.TS.x264-GRP'), 'TS');
  assert.equal(parseSourceTag('Movie 2025 720p TS XviD'), 'TS');
  assert.equal(parseSourceTag('Movie.2025.720p.TS'), 'TS');   // upper case at the end: the tag, not an extension
  assert.equal(parseSourceTag('Movie.2025.HDTS.x264-GRP.ts'), 'TS');
  const s = t('Addon\n1080p', 'Show S01E01 1080p x264-GRP\n👤 12 💾 1.2 GB ⚙️ ProviderA', { behaviorHints: { filename: 'Show.S01E01.1080p.x264-GRP.ts' } });
  assert.equal(s.sourceTag, undefined);
  assert.equal(parseGroup('Show.S01E01.1080p.x264-GRP.ts'), 'GRP');
  assert.equal(parseGroup('Show.S01E01.1080p.x264-GRP.MKV'), 'GRP');
});

test('stripFileExt drops a video extension in any case, .TS included, and only at the end', () => {
  assert.equal(stripFileExt('Show.S01E01.1080p.x264-GRP.TS'), 'Show.S01E01.1080p.x264-GRP');
  assert.equal(stripFileExt('Show.S01E01.1080p.x264-GRP.ts'), 'Show.S01E01.1080p.x264-GRP');
  assert.equal(stripFileExt('Movie.2025.MKV '), 'Movie.2025');
  assert.equal(stripFileExt('Movie.2025.m2ts'), 'Movie.2025');
  assert.equal(stripFileExt('Movie.2025.TS.x264-GRP.mkv'), 'Movie.2025.TS.x264-GRP');
  assert.equal(stripFileExt('Movie.2025.srt'), 'Movie.2025.srt');
});

test('an upper case .TS file extension is not telesync', () => {
  assert.equal(tagOf('Show S01E01 1080p x264-GRP', 'Show.S01E01.1080p.x264-GRP.TS'), undefined);
  assert.equal(tagOf('Show S01E01 1080p x264-GRP', 'Show.S01E01.1080p.WEB-DL.x264-GRP.TS'), 'WEB-DL');
  assert.equal(tagOf('Movie.2025.HDTS.x264-GRP', 'Movie.2025.HDTS.x264-GRP.TS'), 'TS');   // the name still says telesync
});

test('a TS in the release name is still telesync, whatever the file is called', () => {
  assert.equal(tagOf('Movie.2025.720p.TS', 'Movie.2025.720p.TS.mkv'), 'TS');
  assert.equal(tagOf('Movie 2025 720p TS XviD', 'movie.ts'), 'TS');
  assert.equal(tagOf('Movie.2025.720p.TS'), 'TS');
});

test('a release name that is itself a filename keeps the lower case .ts rule', () => {
  assert.equal(tagOf('Show.S01E01.1080p.x264-GRP.ts'), undefined);
  assert.equal(tagOf('Show.S01E01.1080p.WEB.x264-GRP.mkv'), 'WEB');
});

test('sourceTagOf: the strongest tag across release, file and other text wins, as one string did', () => {
  assert.equal(sourceTagOf('Show S02E03 720p WEB h264-GRP', 'Show.S02E03.720p.WEB-DL.h264-GRP.mkv'), 'WEB-DL');
  assert.equal(sourceTagOf('Movie 2025 1080p BluRay x264-GRP', 'Movie.2025.1080p.REMUX.mkv'), 'REMUX');
  assert.equal(sourceTagOf('Movie 2025 1080p', undefined, 'HDTV'), 'HDTV');
  assert.equal(sourceTagOf('Movie 2025 1080p', 'Movie.2025.1080p.mkv'), undefined);
  assert.equal(sourceTagOf(''), undefined);
});

test('audio + dolby vision', () => {
  const s = t('Addon\n4k', 'Movie.2022.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR10+.H.265-GRPY\n👤 300 💾 20 GB ⚙️ EPSILON');
  assert.equal(s.audio, 'Atmos DDP5.1');
  assert.equal(s.hdr, 'DV+HDR10+');
  assert.equal(s.codec, 'hevc');
  assert.equal(s.group, 'GRPY');
});

test('description field (newer protocol) and stremio:// name only', () => {
  const s = parseStream({ name: 'MyAddon\n1080p', description: 'Some.Movie.2019.1080p.WEBRip.x264-[ALPHA.LT]\n👤 5 💾 1.6 GB ⚙️ ZETA', infoHash: 'ff'.repeat(20) }, 'X')!;
  assert.equal(s.addon, 'MyAddon');
  assert.equal(s.sourceTag, 'WEBRip');
  assert.equal(s.provider, 'ZETA');
});

test('a title line with an emoji plus variation selector is kept, not taken for the info line', () => {
  const s = t('Addon\n1080p', 'I.❤️.Paris.2024.1080p.WEB-DL.x264-ALPHA\n👤 42 💾 1.2 GB ⚙️ ALPHA');
  assert.equal(s.releaseName, 'I.❤️.Paris.2024.1080p.WEB-DL.x264-ALPHA');
  assert.equal(s.seeders, 42);
  assert.equal(s.provider, 'ALPHA');
  const bare = t('Addon\n720p', 'Show.S01E01.720p.WEB.h264-BETA\n👤 7 💾 500 MB ⚙ BETA');   // gear without VS16
  assert.equal(bare.releaseName, 'Show.S01E01.720p.WEB.h264-BETA');
  assert.equal(bare.provider, 'BETA');
});

test('codec: every way a release name spells H.264 and H.265', () => {
  const h264 = ['Show.S01E01.1080p.WEB.H264-GRP', 'Show.S01E01.1080p.WEB.h.264-GRP', 'Show S01E01 1080p WEB-DL DDP5 1 H 264-GRP', 'Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GRP',
    'Movie.2024.1080p.WEBRip.x264_GRP', 'Movie.2024.1080p.WEB-DL.H264_GRP', 'Movie 2024 1080p WEB-DL x 264-GRP', 'Movie.2024.1080p.H-264', 'Movie.2024.1080p.Blu-ray.AVC.REMUX'];
  const hevc = ['Show.S01E01.2160p.WEB.H265-GRP', 'Show S01E01 2160p WEB-DL DDP5 1 DV HDR H 265-GRP', 'Movie.2024.2160p.DV.HDR.H.265-GRP', 'Movie.2024.1080p.x265_GRP', 'Movie.2024.HEVC.10bit'];
  for (const n of h264) assert.equal(parseCodec(n), 'h264', n);
  for (const n of hevc) assert.equal(parseCodec(n), 'hevc', n);
  assert.equal(parseCodec('Movie.2024.1080p.AV1.Opus'), 'av1');
  assert.equal(parseCodec('Movie.1999.DVDRip.XviD'), 'other');
  // A digit or a letter glued on either side is not a codec, nor is a bare 264.
  for (const n of ['Movie.2024.1080p.WEB-DL', 'Show.S01E264.1080p', 'Box.264.2024', 'Movie.1264.WEB', 'Movie.2024.H2640', 'Movie.AVCHDX.2024', 'Movie.2024.VC.10', 'Movie.MPEG.2nd.Cut']) assert.equal(parseCodec(n), undefined, n);
  // In a stream: the release name with spaces, then the binge group when the names say nothing.
  assert.equal(t('Addon\n1080p', 'Show S01E01 1080p WEB-DL DDP5 1 H 264-GRP\n👤 9 💾 2 GB ⚙️ ALPHA').codec, 'h264');
  assert.equal(t('Addon\n1080p', 'Show.S01E01.1080p.WEB\n👤 9 💾 2 GB ⚙️ ALPHA', { behaviorHints: { bingeGroup: 'addon|1080p|WEB-DL|h264|GRP' } }).codec, 'h264');
  assert.equal(t('Addon\n1080p', 'Show.S01E01.1080p.WEB\n👤 9 💾 2 GB ⚙️ ALPHA', { behaviorHints: { bingeGroup: 'addon|1080p|h265|GRP' } }).codec, 'hevc');
  assert.equal(t('Addon\n1080p', 'Show.S01E01.1080p.WEB\n👤 9 💾 2 GB ⚙️ ALPHA', { behaviorHints: { bingeGroup: 'addon|1080p|GRP' } }).codec, undefined);
});

test('codec: AVCHD is H.264; VC-1 and MPEG-2 count however the dot or dash was written', () => {
  for (const n of ['Movie.2010.1080i.AVCHD.DD5.1', 'Movie 2010 1080i AVCHD DD5 1', 'AVCHD.Camera.2024']) assert.equal(parseCodec(n), 'h264', n);
  for (const n of ['Movie.2008.1080p.BluRay.VC-1.DTS-HD', 'Movie.2008.1080p.BluRay.VC1', 'Movie.2008.1080p.BluRay.VC.1.DTS', 'Movie 2008 1080p Blu-ray VC 1 DTS-HD MA 5 1',
    'Movie.1999.DVD9.MPEG-2', 'Movie.1999.DVD9.MPEG2', 'Movie.1999.DVD9.MPEG.2.AC3', 'Movie 1999 DVD9 MPEG 2 AC3'])
    assert.equal(parseCodec(n), 'other', n);
});

test('no infoHash -> skipped', () => {
  assert.equal(parseStream({ url: 'http://x/y.mp4', title: 'x' }, 'A'), undefined);
});

test('helpers', () => {
  assert.equal(parseSize('54.33 GB'), Math.round(54.33 * 1024 ** 3));
  assert.equal(parseSize('nope'), undefined);
  assert.equal(parseGroup('A.B.C.2020.1080p-GRP'), 'GRP');
  assert.equal(parseGroup('A.B.C.2020.1080p[GrP]'), 'GrP');
  assert.equal(parseGroup('A.B.C.2020'), undefined);
  assert.equal(parseGroup('Sandstorm.2021.1080p.x264-BluRay'), undefined);
  assert.equal(parseAudio('x.AAC.2.0'), 'AAC');
  assert.equal(parseAudio('x.DTS.5.1'), 'DTS');
  assert.equal(parseAudio('x.5.1'), '5.1');
});

test('group: a space after a glued dash, and a site suffix in brackets or parentheses', () => {
  assert.equal(parseGroup('Show S01E01 1080p WEB-DL DDP5 1 H 265- GRP'), 'GRP');
  assert.equal(parseGroup('Show S01E01 1080p WEB-DL DDP5 1 H 265-  GRP '), 'GRP');
  assert.equal(parseGroup('Show S01E01 1080p WEB H264 -GRP'), 'GRP');
  // Made-up addresses: a site's name never goes in a test.
  assert.equal(parseGroup('Movie.2024.1080p.WEB.H264-GRP (example.com).mkv'), 'GRP');
  assert.equal(parseGroup('Movie.2024.1080p.WEB.H264-GRP.mkv (example.com)'), 'GRP');
  assert.equal(parseGroup('Movie.2024.1080p.BluRay.x264-GRP[example.org]'), 'GRP');
  assert.equal(parseGroup('Movie 2024 1080p x265-GRP [www.example.net]'), 'GRP');
  assert.equal(parseGroup('Movie 2024 1080p H 265- GRP (releases.example.org).mkv'), 'GRP');
  assert.equal(parseGroup('Movie.2024.1080p[GrP] (example.com)'), 'GrP');
  // A spaced dash leads to a title, and a site suffix alone is no group.
  assert.equal(parseGroup('Show S01E01 - Pilot'), undefined);
  assert.equal(parseGroup('Show - Pilot.mkv'), undefined);
  assert.equal(parseGroup('Movie 2024 1080p [example.org]'), undefined);
  assert.equal(parseGroup('Movie.2024.1080p.x264- 1080p'), undefined);
  // In a stream: the release name decides.
  assert.equal(t('Addon\n1080p', 'Show S01E01 1080p WEB-DL DDP5 1 H 265- GRP\n👤 9 💾 2 GB ⚙️ ALPHA').group, 'GRP');
});

test('reparse: a stored source read again by the parser as it is now; counts, size, provider and an unknown resolution stay', () => {
  const stored: Source = { id: 'h:0', infoHash: 'h', addon: 'Local', provider: 'ProviderA', releaseName: 'Movie 2008 1080p Blu-ray VC 1 DTS-HD MA 5 1- GRP', seeders: 40, seedersLive: true, sizeBytes: 9e9,
    resolution: '1080p', codec: undefined, sourceTag: undefined, score: 7, warnings: ['old'] };
  const r = reparse(stored);
  assert.deepEqual([r.codec, r.group, r.sourceTag, r.resolution, r.audio], ['other', 'GRP', 'BluRay', '1080p', 'DTS-HD']);
  assert.deepEqual([r.seeders, r.seedersLive, r.sizeBytes, r.provider, r.id], [40, true, 9e9, 'ProviderA', 'h:0']);
  assert.equal(stored.group, undefined, 'the stored source is left alone');
  assert.equal(reparse({ ...stored, releaseName: 'Movie 2008', resolution: '720p' }).resolution, '720p', 'the names say nothing: the addon line may have');
  assert.equal(reparse({ ...stored, releaseName: 'Movie 2008', filename: 'Movie.2008.2160p.mkv' }).resolution, '2160p', 'the file name counts');
  // The same fields as a fresh parse of the same names.
  const fresh = t('Addon', 'Show.S01E01.1080p.WEB-DL.DDP5.1.Atmos.DV.HDR10+.H.265.ITA.ENG-GRP\n👤 9 💾 2 GB ⚙️ ProviderA', { behaviorHints: { bingeGroup: 'addon|1080p' } });
  const again = reparse({ ...fresh, codec: undefined, hdr: undefined, audio: undefined, sourceTag: undefined, group: undefined, langs: undefined, foreignAudio: undefined });
  for (const k of ['resolution', 'codec', 'hdr', 'audio', 'sourceTag', 'group', 'langs', 'foreignAudio'] as const) assert.deepEqual(again[k], fresh[k], k);
});

test('release-name language detection: dubs, dual audio, plain English', () => {
  assert.deepEqual(parseLangs('Sousede / The Neighbours 2. serie (CZ/EN)[1080p][WEB-DL]').foreignAudio, 'dual');
  assert.equal(parseLangs('The Neighbours S02 WEB-DL 1080p AVC [Tamil + Telugu + Hindi]').foreignAudio, 'dub');
  assert.equal(parseLangs('Соседи / The Neighbours [S02] (2026) WEB-DL 1080p').foreignAudio, 'dub');
  assert.equal(parseLangs('Sąsiedzi S02E06 [10Bit HDR] [1080p.WEB-DL.H265]').langs[0], 'pol');
  assert.equal(parseLangs('The Neighbours S02E06 MULTi 1080p WEB-DL H264 DDP5.1').foreignAudio, undefined);
  assert.equal(parseLangs('the.neighbours.2024.s02e06.1080p.web.h264-grp').foreignAudio, undefined);
  assert.equal(parseLangs('Dan.Ben.Ron.Brown.1080p').foreignAudio, undefined, 'names are not languages');
  assert.equal(parseLangs('Harbor.S01E05.1080p.WEB-DL').foreignAudio, undefined, 'nothing announced, nothing implied');
});

test('placeholder seeds: one provider says 100 on every release, the count is flagged, real counts are not', () => {
  const fixed1 = t('Addon\n1080p', `The.Drama.2026.1080p.BluRay.x264\n👤 100 💾 1.9 GB ⚙️ ${FIXED}`);
  const fixed2 = t('Addon\n1080p', `The.Drama.2026.1080p.WEBRip.x264\n👤 100 💾 2.0 GB ⚙️ ${FIXED}`, { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF02' });
  const other1 = t('Addon\n1080p', 'The.Drama.2026.1080p.WEB-DL.x265\n👤 118 💾 1.6 GB ⚙️ ProviderB', { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF03' });
  const other2 = t('Addon\n1080p', 'The.Drama.2026.1080p.WEBRip.x265\n👤 363 💾 1.1 GB ⚙️ ProviderB', { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF04' });
  flagPlaceholderSeeds([fixed1, fixed2, other1, other2]);
  assert.equal(fixed1.seedersEstimated, true);
  assert.equal(fixed2.seedersEstimated, true);
  assert.equal(other1.seedersEstimated, undefined);
  assert.equal(other2.seedersEstimated, undefined);
  // a lone row is a real count, whatever it says
  const lone = t('Addon\n720p', 'The.Drama.2026.720p.BluRay.x264\n👤 100 💾 0.9 GB ⚙️ ALPHA', { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF06' });
  flagPlaceholderSeeds([lone]);
  assert.equal(lone.seedersEstimated, undefined);
});

test('live seeds from the trackers replace addon figures and clear the placeholder flag', () => {
  const fixed = t('Addon\n1080p', `The.Drama.2026.1080p.WEBRip.x264\n👤 100 💾 2.0 GB ⚙️ ${FIXED}`);
  const quiet = t('Addon\n1080p', 'The.Drama.2026.1080p.WEB-DL.x265\n👤 118 💾 1.6 GB ⚙️ ProviderB', { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF07' });
  fixed.seedersEstimated = true;
  applyLiveSeeds([fixed, quiet], new Map([[fixed.infoHash, 1612], [quiet.infoHash, -1]]));
  assert.equal(fixed.seeders, 1612);
  assert.equal(fixed.seedersLive, true);
  assert.equal(fixed.seedersEstimated, undefined);
  assert.equal(quiet.seeders, 118);   // nobody answered: the addon's number stays, unmarked
  assert.equal(quiet.seedersLive, undefined);
});

test('a live count keeps the addon\'s own figure beside it, never a placeholder or a figure that was live already', () => {
  const real = t('Addon\n1080p', 'Show.S01E01.1080p.WEB.H264-GRP\n👤 240 💾 1.0 GB ⚙️ ProviderA');
  const guess = t('Addon\n1080p', 'Show.S01E01.720p.WEB.H264-GRP\n👤 100 💾 0.5 GB ⚙️ ProviderB', { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF08' });
  guess.seedersEstimated = true;
  applyLiveSeeds([real, guess], new Map([[real.infoHash, 900], [guess.infoHash, 12]]));
  assert.deepEqual([real.seeders, real.seedersAddon], [900, 240]);
  assert.deepEqual([guess.seeders, guess.seedersAddon], [12, undefined]);
  applyLiveSeeds([real], new Map([[real.infoHash, 950]]));
  assert.deepEqual([real.seeders, real.seedersAddon], [950, 240], 'a second scrape does not take the last live count for the addon\'s');
});
