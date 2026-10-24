import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Torrent } from 'webtorrent';
import { acceptLanguages, normLang, getVtt } from '../server/subs/index.ts';
import { encodeSubId } from '../server/subs/ids.ts';
import { killChildren } from '../server/lifecycle.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
/** A stand-in ffmpeg: a shell script, made executable. */
const stub = (name: string, body: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };
const H = 'ab'.repeat(20);
/** A fully downloaded video whose embedded stream `s` is a text subtitle. Each test its own stream: the id is cached on disk. */
const embedded = (s: number) => encodeSubId({ o: 'e', h: H, i: 0, s });
const torrentOf = (h: string) => (h === H ? { files: [{ progress: 1 }] } as unknown as Torrent : undefined);

test('accept-language parses, ranks by q, maps to ISO-639-2, dedupes', () => {
  assert.deepEqual(acceptLanguages('nb-NO,nb;q=0.9,no;q=0.8,en-US;q=0.7,en;q=0.6'), ['nob', 'nor', 'eng']);
  assert.deepEqual(acceptLanguages('en;q=0.5, de'), ['deu', 'eng']);
  assert.deepEqual(acceptLanguages(undefined), []);
  assert.deepEqual(acceptLanguages('*'), []);
});

test('normLang handles 2 and 3 letter codes and legacy codes', () => {
  assert.equal(normLang('en'), 'eng');
  assert.equal(normLang('nb-NO'), 'nob');
  assert.equal(normLang('ger'), 'deu');
  assert.equal(normLang('Norwegian'), 'und');
  assert.equal(normLang('norsk'), 'nor');
});

// FFMPEG_BIN is set after the import on purpose: the binary is looked up per spawn (binPath), as playback does.
test('embedded subtitles are extracted with the ffmpeg binPath picks at the time of the call', async () => {
  process.env.FFMPEG_BIN = stub('vtt-ffmpeg', "printf 'WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nHello\\n'");
  assert.match(await getVtt(embedded(2), 0, torrentOf), /^WEBVTT\n\n[\d:.]+ --> [\d:.]+\nHello\n/);
});

test('an extraction still running is killed by the shutdown, at once', async () => {
  process.env.FFMPEG_BIN = stub('slow-ffmpeg', 'exec sleep 30');
  const t0 = Date.now();
  const vtt = getVtt(embedded(3), 0, torrentOf);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(killChildren(), 1);
  await assert.rejects(vtt, /extract failed/);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('an embedded track before the file has fully downloaded is a 409 that says so, and nothing runs', async () => {
  process.env.FFMPEG_BIN = path.join(tmp, 'no-such-ffmpeg');
  const partial = (h: string) => (h === H ? { files: [{ progress: 0.4 }] } as unknown as Torrent : undefined);
  await assert.rejects(getVtt(embedded(5), 0, partial), (e: unknown) => (e as { status?: number }).status === 409 && /available once the file has fully downloaded/.test((e as Error).message));
  assert.equal(killChildren(), 0);
});

test('a missing ffmpeg: extraction says it could not start', async () => {
  process.env.FFMPEG_BIN = path.join(tmp, 'no-such-ffmpeg');
  await assert.rejects(getVtt(embedded(4), 0, torrentOf), /ffmpeg could not start: ENOENT \(not found\)/);
  assert.equal(killChildren(), 0);
});
