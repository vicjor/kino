import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, fmtBytes, langName, relTime, episodeTag, chosenFirst, audioDetail, units, minutesLeftLabel, skipLabel, offsetLabel, uptimeLabel, osName } from '../client/lib/format.ts';

test('units: spelled out, singular only for exactly one', () => {
  assert.equal(units(1, 'minute'), '1 minute');
  assert.equal(units(12, 'minute'), '12 minutes');
  assert.equal(units(0, 'hour'), '0 hours');
  assert.equal(units(0.6, 'day'), '1 day', 'rounded before the plural is picked');
  assert.equal(units(0.1, 'second', 1), '0.1 seconds');
  assert.equal(units(1, 'second', 1), '1.0 seconds');
  assert.equal(units(-1.2, 'second', 1), '-1.2 seconds');
});

test('minutesLeftLabel, skipLabel, offsetLabel: the player and resume copy', () => {
  assert.equal(minutesLeftLabel(12), '12 minutes left');
  assert.equal(minutesLeftLabel(1), '1 minute left');
  assert.equal(skipLabel(10), '+10 seconds');
  assert.equal(skipLabel(-10), '−10 seconds');
  assert.equal(skipLabel(60), '+1 minute');
  assert.equal(skipLabel(-120), '−2 minutes');
  assert.equal(offsetLabel(300), '+0.3 seconds');
  assert.equal(offsetLabel(0), '+0.0 seconds');
  assert.equal(offsetLabel(-1200), '-1.2 seconds');
});

test('uptimeLabel: minutes, then hours, then days from two days on', () => {
  assert.equal(uptimeLabel(0), '0 minutes');
  assert.equal(uptimeLabel(61), '1 minute');
  assert.equal(uptimeLabel(3599), '59 minutes');
  assert.equal(uptimeLabel(3600), '1 hour');
  assert.equal(uptimeLabel(3 * 3600 + 1800), '3 hours');
  assert.equal(uptimeLabel(47 * 3600), '47 hours');
  assert.equal(uptimeLabel(5 * 86400), '5 days');
});

test('osName: the platforms people know by name, anything else as given', () => {
  assert.equal(osName('darwin'), 'macOS');
  assert.equal(osName('linux'), 'Linux');
  assert.equal(osName('win32'), 'Windows');
  assert.equal(osName('aix'), 'aix');
});

test('fmtTime: minutes and seconds, hours only when there are some', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(59), '0:59');
  assert.equal(fmtTime(59.9), '0:59');
  assert.equal(fmtTime(60), '1:00');
  assert.equal(fmtTime(605), '10:05');
  assert.equal(fmtTime(3600), '1:00:00');
  assert.equal(fmtTime(3661), '1:01:01');
});

test('fmtTime: nothing sensible reads as 0:00', () => {
  assert.equal(fmtTime(NaN), '0:00');
  assert.equal(fmtTime(undefined), '0:00');
  assert.equal(fmtTime(Infinity), '0:00');
  assert.equal(fmtTime(-5), '0:00');
});

test('fmtBytes: KB, MB, GB with one decimal below 10 GB', () => {
  assert.equal(fmtBytes(undefined), '');
  assert.equal(fmtBytes(0), '');
  assert.equal(fmtBytes(-1), '');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(5 * 1024 ** 2), '5 MB');
  assert.equal(fmtBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(fmtBytes(10 * 1024 ** 3), '10 GB');
  assert.equal(fmtBytes(12.4 * 1024 ** 3), '12 GB');
});

test('langName: three-letter codes, a longer tag by its first three letters, unknown codes as given', () => {
  assert.equal(langName('eng'), 'English');
  assert.equal(langName('ger'), 'German');
  assert.equal(langName('pob'), 'Portuguese (BR)');
  assert.equal(langName('nor-NO'), 'Norwegian');
  assert.equal(langName('xyz'), 'xyz');
  assert.equal(langName(''), '');
});

test('relTime: full words, singular for one, rounded at each step', () => {
  const now = 1_700_000_000_000;
  const ago = (sec: number) => relTime(now - sec * 1000, now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(89), 'just now');
  assert.equal(ago(90), '2 minutes ago');
  assert.equal(ago(59 * 60), '59 minutes ago');
  assert.equal(ago(59.5 * 60), '1 hour ago');
  assert.equal(ago(89 * 60), '1 hour ago');
  assert.equal(ago(90 * 60), '2 hours ago');
  assert.equal(ago(3 * 3600), '3 hours ago');
  assert.equal(ago(23 * 3600), '23 hours ago');
  assert.equal(ago(23.5 * 3600), '1 day ago');
  assert.equal(ago(36 * 3600), '2 days ago');
  assert.equal(ago(30 * 86400), '30 days ago');
});

test('relTime: a time in the future (clock skew between devices) reads as just now', () => {
  assert.equal(relTime(2_000_000, 1_000_000), 'just now');
});

test('episodeTag: season and episode from a file name, in the app style', () => {
  assert.equal(episodeTag('Some.Show.S02E05.1080p.WEB.x264.mkv'), 'S2 E5');
  assert.equal(episodeTag('some show s1e3 720p.mp4'), 'S1 E3');
  assert.equal(episodeTag('Some Show - S03 E10 - Title.mkv'), 'S3 E10');
  assert.equal(episodeTag('Some.Show.S01.E07.mkv'), 'S1 E7');
  assert.equal(episodeTag('Some.Show.S01E01E02.mkv'), 'S1 E1');
  assert.equal(episodeTag('Some Show 2x05.avi'), 'S2 E5');
  assert.equal(episodeTag('S04E12.mkv'), 'S4 E12');
});

test('chosenFirst: picks in tap order, then the rest in list order, nothing twice', () => {
  const all = ['eng', 'nor', 'swe', 'dan'];
  assert.deepEqual(chosenFirst([], all), all);
  assert.deepEqual(chosenFirst(['swe', 'eng'], all), ['swe', 'eng', 'nor', 'dan']);
  // A choice made elsewhere (Settings) that is not in the list still shows, in its place.
  assert.deepEqual(chosenFirst(['jpn', 'nor'], all), ['jpn', 'nor', 'eng', 'swe', 'dan']);
});

test('episodeTag: nothing for films, resolutions, codecs and season-only names', () => {
  assert.equal(episodeTag('A.Film.2019.1080p.BluRay.x264.mkv'), '');
  assert.equal(episodeTag('Clip.1920x1080.mp4'), '');
  assert.equal(episodeTag('Some.Show.S02.Complete.mkv'), '');
  assert.equal(episodeTag('Sample.mkv'), '');
  assert.equal(episodeTag('ABS01E01.mkv'), '');
});

test('audioDetail: channels and well known formats in plain words, no codec names', () => {
  assert.equal(audioDetail('ac3', 6), 'Surround 5.1 · Dolby Digital');
  assert.equal(audioDetail('EAC3', 6), 'Surround 5.1 · Dolby Digital Plus');
  assert.equal(audioDetail('truehd', 8), 'Surround 7.1 · Dolby TrueHD');
  assert.equal(audioDetail('dts', 6), 'Surround 5.1 · DTS');
  assert.equal(audioDetail('aac', 2), 'Stereo');
  assert.equal(audioDetail('opus', 1), 'Mono');
  assert.equal(audioDetail('flac', 4), '4 channels');
  assert.equal(audioDetail('aac'), '', 'nothing to say: the row shows the language alone');
});
