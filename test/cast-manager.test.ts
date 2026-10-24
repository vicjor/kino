import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CastSession, RawStatus } from '../server/cast/session.ts';
import type { Meta, ProbeInfo, Source, SubtitleTrack } from '../server/types.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
(await import('../server/config.ts')).ensureDirs();   // the data folders the server makes at boot
const cast = await import('../server/cast/manager.ts');
const { getProgress, saveProgress, flushSync, getState, update } = await import('../server/store.ts');
const { statusOf, publicMessage, UNEXPECTED } = await import('../server/errors.ts');
const scrape = await import('../server/scrape.ts');
const { io } = cast;
// Fake trackers for auto-next's live seeders: no test here ever asks a public one. They answer from `trackerSeeds`.
const trackerSeeds = new Map<string, number>();
scrape.setScrapeForTests(async (hashes) => new Map(hashes.filter((h) => trackerSeeds.has(h)).map((h) => [h, trackerSeeds.get(h)!])));
// stop first, then write any pending state now: a debounced store write after the rm would recreate the dir
after(async () => { await cast.stop(false); scrape.setScrapeForTests(null); flushSync(); fs.rmSync(DIR, { recursive: true, force: true }); });

// ---- fakes: a Chromecast connection, the HLS sessions, the torrent side ----
class FakeTv extends EventEmitter {
  loads: { media: { contentId: string }; at: number; ids: number[]; resolve: () => void; reject: (e: Error) => void }[] = [];
  /** Every EDIT_TRACKS_INFO: the text track ids switched on. */
  tracks: number[][] = [];
  closed = false; quits = 0; stops = 0;
  load(media: { contentId: string }, opts: { currentTime?: number; activeTrackIds?: number[] }): Promise<void> {
    if (this.closed) return Promise.reject(new Error('not connected'));
    for (const l of this.loads) l.reject(new Error('Load cancelled'));   // a newer LOAD interrupts the one still loading
    return new Promise((resolve, reject) => { const l = { media, at: opts.currentTime || 0, ids: opts.activeTrackIds || [], resolve: () => { this.loads = this.loads.filter((x) => x !== l); resolve(); }, reject: (e: Error) => { this.loads = this.loads.filter((x) => x !== l); reject(e); } }; this.loads.push(l); });
  }
  setTracks(ids: number[]) { this.tracks.push(ids); return Promise.resolve(); }
  stop() { this.stops++; return Promise.resolve(); }
  quit() { this.quits++; return Promise.resolve(); }
  seek(_t: number) { return Promise.resolve(); }
  destroy() { if (this.closed) return; this.closed = true; for (const l of [...this.loads]) l.reject(new Error('Chromecast connection closed')); this.emit('close'); }
  report(s: Partial<RawStatus>) { this.emit('status', { state: 'PLAYING', currentTime: 0, volume: 1, muted: false, activeTrackIds: [], ...s }); }
}

interface FakeHls { id: string; infoHash: string; startOffset: number; state: 'starting' | 'ready' | 'ended'; parked: boolean; ready: () => void; fail: (e: Error) => void; done: Promise<void> }
let hlsN = 0;
const hlsMap = new Map<string, FakeHls>();
const started: FakeHls[] = [];
const fakeHls = {
  // Like hls.start with an owner: a session of the same file with media (running or finished) is parked, anything else stopped.
  start(o: { infoHash: string; startOffset: number }) {
    for (const s of [...hlsMap.values()]) { if (s.parked) continue; if (s.infoHash === o.infoHash && s.state !== 'starting') s.parked = true; else fakeHls.stop(s.id); }
    let ready!: () => void; let fail!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => { ready = res; fail = rej; });
    done.catch(() => undefined);
    const s: FakeHls = { id: `h${++hlsN}`, infoHash: o.infoHash, startOffset: o.startOffset, state: 'starting', parked: false, ready: () => { s.state = 'ready'; ready(); }, fail, done };
    hlsMap.set(s.id, s); started.push(s);
    return s;
  },
  waitReady(s: FakeHls) { return s.done; },
  stop(id: string) { const s = hlsMap.get(id); if (!s) return; hlsMap.delete(id); s.fail(new Error('Stream session was replaced')); },
  revive(id: string) { const s = hlsMap.get(id); if (s) s.parked = false; return !!s; },
};

const MKV: ProbeInfo = { container: 'mkv', duration: 3600, video: { codec: 'hevc', height: 1080 }, audio: [{ index: 1, codec: 'aac' }], subs: [] };
const MP4: ProbeInfo = { container: 'mp4', duration: 3600, video: { codec: 'h264', height: 1080 }, audio: [{ index: 1, codec: 'aac' }], subs: [] };
let tvs: FakeTv[] = [];
let probes: Record<string, ProbeInfo> = {};

beforeEach(async () => {
  await cast.stop(false);
  tvs = []; probes = {}; hlsMap.clear(); started.length = 0;
  Object.assign(io, {
    device: (id: string) => ({ id, name: `TV ${id}`, model: 'Chromecast', host: '10.0.0.9', port: 8009, audioOnly: false }),
    renderer: () => false,
    media: async (id: string) => ({ t: { infoHash: id, files: [{ name: 'film.mkv' }] }, idx: 0, local: `http://x/${id}`, probe: probes[id] || MKV }),
    subtitles: async () => [],
    connect: async () => { const tv = new FakeTv(); tvs.push(tv); return tv as unknown as CastSession; },
    hls: fakeHls,
    meta: async () => { throw new Error('no network in tests'); },
    streams: async () => { throw new Error('no network in tests'); },
  });
});

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const req = (more: object = {}) => ({ deviceId: 'living', infoHash: 'aaa', fileIdx: -1, videoId: 'tt1', title: 'Film', startTime: 0, ...more });
/** Cast to "living" and let it play: hls ready, LOAD answered, the TV reporting PLAYING at `at` seconds into its timeline. */
async function playing(more: object = {}, at = 0) {
  const p = cast.castTo(req(more));
  await flush(); started.at(-1)?.ready(); await flush();
  const tv = tvs.at(-1)!; tv.loads.at(-1)!.resolve(); await p;
  tv.report({ currentTime: at });
  return tv;
}

test('a burst of seek presses ends in one load at the last time, and every press answers quietly', { timeout: 5000 }, async () => {
  const tv = await playing();
  const presses = [cast.seek(100), cast.seek(110), cast.seek(120)];
  assert.equal(cast.status().currentTime, 120, 'the status says where the seek goes');
  assert.equal(cast.status().state, 'BUFFERING');
  await flush();
  assert.equal(started.length, 2, 'one ffmpeg for the burst, not one per press');
  started[1].ready(); await flush();
  assert.equal(tv.loads.length, 1);
  tv.loads[0].resolve();
  await Promise.all(presses);
  assert.equal(tvs.length, 1, 'same connection');
  assert.equal(cast.status().deviceId, 'living');
  assert.equal(cast.status().timeOffset, 120);
  assert.ok(!hlsMap.has(started[0].id), 'the old session is stopped once the new one plays');
});

test('a seek while another is starting replaces it: no "session was replaced" error', { timeout: 5000 }, async () => {
  const tv = await playing();
  const first = cast.seek(300);
  await flush();                       // the first press is waiting for its first segment
  const second = cast.seek(600);
  await flush();
  await first;                         // returns quietly: its ffmpeg was stopped by the newer press
  started.at(-1)!.ready(); await flush();
  tv.loads.at(-1)!.resolve();
  await second;
  assert.equal(cast.status().timeOffset, 600);
  assert.equal(tv.loads.length, 0);
});

test('stop pressed while a start waits for its stream wins: nothing loads, the receiver app goes', { timeout: 5000 }, async () => {
  const p = cast.castTo(req());
  await flush();
  await cast.stop();
  started[0].ready(); await flush();
  const s = await p;
  assert.equal(s.active, false);
  assert.equal(cast.status().active, false);
  assert.equal(tvs[0].loads.length, 0, 'no LOAD after the stop');
  assert.equal(tvs[0].quits, 1); assert.equal(tvs[0].closed, true);
  assert.equal(hlsMap.size, 0);
});

test('stop pressed while the TV loads wins, and the start returns at once', { timeout: 5000 }, async () => {
  const p = cast.castTo(req());
  await flush(); started[0].ready(); await flush();
  assert.equal(tvs[0].loads.length, 1);
  await cast.stop();
  const s = await p;                   // the load failed when the connection closed: quiet
  assert.equal(s.active, false);
  assert.equal(hlsMap.size, 0);
});

test('two starts for the same idle TV: the older leaves the receiver app up for the newer', { timeout: 5000 }, async () => {
  const a = cast.castTo(req({ infoHash: 'aaa' }));
  await flush();                       // a has connected and waits for its stream
  const b = cast.castTo(req({ infoHash: 'bbb', videoId: 'tt2' }));
  await flush();
  await a;
  assert.equal(tvs[0].closed, true); assert.equal(tvs[0].quits, 0, 'not quit: b needs the app');
  started.at(-1)!.ready(); await flush();
  tvs[1].loads[0].resolve();
  const s = await b;
  assert.equal(s.videoId, 'tt2');
  assert.equal(started.filter((x) => hlsMap.has(x.id)).length, 1);
});

test('same TV, the new stream fails: the old one plays on, its ffmpeg woken', { timeout: 5000 }, async () => {
  const tv = await playing({}, 50);
  const old = started[0];
  const p = assert.rejects(cast.seek(900), /Could not start the stream: Transcoder failed: boom/);
  await flush();
  assert.equal(old.parked, true);
  started[1].fail(new Error('Transcoder failed: boom'));
  await p;
  assert.equal(old.parked, false);
  assert.equal(cast.status().active, true);
  assert.equal(cast.status().state, 'PLAYING');
  assert.equal(cast.status().currentTime, 50, 'back to where it plays, not where the seek meant to go');
  assert.equal(tv.closed, false);
});

test('same TV, the new stream fails and the old one is gone too: the cast ends cleanly', { timeout: 5000 }, async () => {
  const tv = await playing({}, 50);
  const p = assert.rejects(cast.castTo(req({ infoHash: 'bbb', videoId: 'tt2' })), /Could not start the stream/);   // another file: the old ffmpeg is stopped, not parked
  await flush();
  started[1].fail(new Error('Transcoder failed: boom'));
  await p;
  assert.equal(cast.status().active, false);
  assert.equal(tv.closed, true); assert.equal(tv.quits, 1);
});

test('the TV going idle on the old media while its replacement starts ends nothing', { timeout: 5000 }, async () => {
  const tv = await playing();
  const p = cast.seek(400);
  await flush();
  tv.report({ state: 'IDLE', idleReason: 'ERROR' });
  await flush();
  assert.equal(tv.closed, false);
  started.at(-1)!.ready(); await flush();
  tv.loads[0].resolve(); await p;
  assert.equal(cast.status().active, true);
  assert.equal(cast.status().timeOffset, 400);
});

test('another title on the same TV saves where the old one was', { timeout: 5000 }, async () => {
  probes.ccc = MP4;
  const tv = await playing({ videoId: 'tt9:1:2', infoHash: 'ccc' }, 1234);   // direct play: the TV time is the film time
  const p = cast.castTo(req({ infoHash: 'ddd', videoId: 'tt7' }));
  await flush(); started.at(-1)!.ready(); await flush();
  tv.loads[0].resolve(); await p;
  assert.equal(getProgress('tt9:1:2')?.pos, 1234);
});

test('a direct-play seek goes to the TV, no restart', { timeout: 5000 }, async () => {
  probes.ccc = MP4;
  const tv = await playing({ infoHash: 'ccc' });
  let to = -1; tv.seek = (t: number) => { to = t; return Promise.resolve(); };
  await cast.seek(77);
  assert.equal(to, 77);
  assert.equal(tv.loads.length, 0);
});

test('a load the TV never answers reads "The TV did not answer" and ends the cast', { timeout: 5000 }, async () => {
  const p = assert.rejects(cast.castTo(req()), { message: 'The TV did not answer', status: 504 });
  await flush(); started[0].ready(); await flush();
  tvs[0].loads[0].reject(new Error('Chromecast load timed out after 90 s'));
  await p;
  assert.equal(cast.status().active, false);
  assert.equal(tvs[0].closed, true);
});

test('a pause the TV never answers reads the same', { timeout: 5000 }, async () => {
  const tv = await playing();
  Object.assign(tv, { pause: () => Promise.reject(new Error('Chromecast pause timed out after 8 s')) });
  await assert.rejects(cast.pause(), { message: 'The TV did not answer' });
});

test('a command the receiver turns down ("Invalid request: ...") is a 409 in words, and the cast plays on', { timeout: 5000 }, async () => {
  probes.ddd = MP4;
  const tv = await playing({ infoHash: 'ddd' });
  Object.assign(tv, { seek: () => Promise.reject(new Error('Invalid request: INVALID_MEDIA_SESSION_ID')), pause: () => Promise.reject(new Error('Invalid request: INVALID_COMMAND')) });
  await assert.rejects(cast.seek(77), { status: 409, message: 'What was playing on the TV has changed. Try again.' });
  await assert.rejects(cast.pause(), { status: 409, message: 'The app on the TV does not let Kino do that' });
  assert.equal(cast.status().active, true);
});

test('a TV Kino does not know answers 404, not 500', { timeout: 5000 }, async () => {
  io.device = () => undefined;
  await assert.rejects(cast.castTo(req()), { message: 'TV or speaker not found. Refresh the device list.', status: 404 });
});

/** What the phone gets for an error: its status and the text jsonErrors answers with. */
const answer = (e: unknown) => [statusOf(e), publicMessage(e)];

test('a stream the Chromecast refuses is a 502 in words; ffmpeg failing keeps its own 5xx, else 500', { timeout: 5000 }, async () => {
  const p = cast.castTo(req()).catch((e: unknown) => e);
  await flush(); started[0].ready(); await flush();
  tvs[0].loads[0].reject(new Error('Load failed'));
  assert.deepEqual(answer(await p), [502, 'Chromecast refused the stream: Load failed']);
  for (const [inner, status] of [[Object.assign(new Error('Transcoder is still starting, retry'), { status: 503 }), 503], [new Error('Transcoder failed: boom'), 500]] as const) {
    const q = cast.castTo(req({ infoHash: 'bbb' })).catch((e: unknown) => e);
    await flush(); started.at(-1)!.fail(inner);
    assert.deepEqual(answer(await q), [status, `Could not start the stream: ${inner.message}`]);
  }
});

test('a stream that fails to start keeps its error code, so the phone words it as the player does', { timeout: 5000 }, async () => {
  const { codeOf } = await import('../server/errors.ts');
  for (const code of ['transcode-failed', 'tool-broken', 'disk-full', undefined] as const) {
    const q = cast.castTo(req({ infoHash: 'bbb' })).catch((e: unknown) => e);
    await flush(); started.at(-1)!.fail(Object.assign(new Error('Transcoder failed: boom'), { status: 500, code }));
    const e = await q;
    assert.deepEqual([...answer(e), codeOf(e)], [500, 'Could not start the stream: Transcoder failed: boom', code], String(code));
  }
});

const DLNA_GONE = [404, 'TV not found. Is it on and connected to this Wi-Fi?'];
const CAST_GONE = [404, 'TV or speaker not found. Refresh the device list.'];

test('a DLNA TV Kino does not know is a 404 in words, and the Chromecast cast plays on', { timeout: 5000 }, async () => {
  const tv = await playing();
  assert.deepEqual(answer(await cast.castTo(req({ deviceId: 'dlna:gone' })).catch((x: unknown) => x)), DLNA_GONE);
  assert.equal(cast.status().active, true);
  assert.equal(cast.status().deviceId, 'living');
  assert.deepEqual([tv.closed, tv.stops, tv.quits], [false, 0, 0], 'nothing sent to the TV');
  assert.ok(hlsMap.has(started[0].id), 'its stream keeps running');
});

test('a start for a TV Kino does not know does not take over from a seek still starting', { timeout: 5000 }, async () => {
  const tv = await playing();
  const seek = cast.seek(300);
  await flush();
  io.device = (id: string) => (id === 'living' ? { id, name: 'TV living', model: 'Chromecast', host: '10.0.0.9', port: 8009, audioOnly: false } : undefined);
  assert.deepEqual(answer(await cast.castTo(req({ deviceId: 'gone' })).catch((x: unknown) => x)), CAST_GONE);
  started.at(-1)!.ready(); await flush();
  tv.loads.at(-1)!.resolve();
  await seek;
  assert.equal(cast.status().timeOffset, 300, 'the seek went through');
});

test('viaDlna: dlna.ts\'s own errors keep their status and words, a silent TV is a 504, an unreachable one a 503, the rest as it was', async () => {
  const fake = (e: unknown) => cast.viaDlna(async () => { throw e; }).catch((x: unknown) => x);
  for (const e of [Object.assign(new Error('The TV refused the command'), { status: 502, detail: 'Pause failed: Transition not available' }), Object.assign(new Error('This TV has no volume control Kino can use'), { status: 409 })]) {
    assert.equal(await fake(e), e, e.message);
  }
  for (const e of [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new Error('Living refused the stream: The operation was aborted due to timeout')]) {
    assert.deepEqual(answer(await fake(e)), [504, 'The TV did not answer'], String(e));
  }
  const off = new TypeError('fetch failed', { cause: new Error('connect EHOSTUNREACH 192.168.1.20:1400') });
  assert.deepEqual(answer(await fake(off)), [503, 'Kino could not reach the TV. Is it on and connected to this Wi-Fi?']);
  const own = [Object.assign(new Error('Disk full'), { statusCode: 507 }), Object.assign(new Error('No peers found'), { status: 404 })];
  // A plain Error is a surprise however it reads: the generic sentence for the phone, its text for the log.
  const library = [new TypeError("Cannot read properties of null (reading 'x')"), new Error('ffprobe failed: x'), new Error('No video file in torrent'), new Error('404 Not Found for https://x.example/a')];
  for (const e of [...own, ...library]) assert.equal(await fake(e), e, String(e));
  assert.deepEqual(answer(await fake(new Error('No video file in torrent'))), [500, UNEXPECTED]);
  assert.equal(await cast.viaDlna(async () => 'ok'), 'ok');
});

// ---- Next: a two-episode show, one source for episode 2 ----
const show = { id: 'tt5', type: 'series', name: 'Show', videos: [{ id: 'tt5:1:1', season: 1, episode: 1, title: 'One' }, { id: 'tt5:1:2', season: 1, episode: 2, title: 'Two' }] } as unknown as Meta;
const source = (infoHash: string): Source => ({ id: `${infoHash}:0`, infoHash, fileIdx: 0, addon: 'T', releaseName: 'Show.S01E02.1080p.WEB-DL.x264', seeders: 100, sizeBytes: 2 * 1024 ** 3, resolution: '1080p', codec: 'h264', sourceTag: 'WEB-DL', score: 0, warnings: [] });

test('a manual Next whose cast fails says why, not "No next episode"', { timeout: 5000 }, async () => {
  await playing({ videoId: 'tt5:1:1' }, 100);
  io.meta = async () => show;
  io.streams = async () => ({ sources: [source('bbb')], queried: [], failed: [] });
  const p = assert.rejects(cast.castNext(), /^Error: Could not start the stream: Transcoder failed: boom$/);
  await flush();
  assert.equal(started.length, 2, 'the next episode started');
  started[1].fail(new Error('Transcoder failed: boom'));
  await p;
});

test('Next with nothing after this episode: 404 with the plain reason; a Cinemeta failure says so', { timeout: 5000 }, async () => {
  await playing({ videoId: 'tt5:1:2' }, 100);
  io.meta = async () => show;
  await assert.rejects(cast.castNext(), { message: 'No next episode with a playable source', status: 404 });
  io.meta = async () => { throw new Error('Cinemeta did not answer'); };
  await assert.rejects(cast.castNext(), { message: 'Cinemeta did not answer' });
  await cast.stop(false);
  await assert.rejects(cast.castNext(), { message: 'Nothing is casting', status: 409 });
});

test('a manual Next that works casts episode 2 on the same TV', { timeout: 5000 }, async () => {
  const tv = await playing({ videoId: 'tt5:1:1' }, 100);
  io.meta = async () => show;
  io.streams = async () => ({ sources: [source('bbb')], queried: [], failed: [] });
  const p = cast.castNext();
  await flush(); started[1].ready(); await flush();
  tv.loads[0].resolve();
  const s = await p;
  assert.equal(s.videoId, 'tt5:1:2');
  assert.equal(s.infoHash, 'bbb');
  assert.equal(s.title, 'Show S1 E2 Two', 'named like a cast started from the title page, so Continue watching and the history match');
  assert.equal(tvs.length, 1);
});

test('Next at the credits checks the episode off: it counts as watched, not left at the credits', { timeout: 5000 }, async () => {
  saveProgress({ videoId: 'tt5:1:1', metaId: 'tt5', type: 'series', pos: 1300, dur: 1440, updatedAt: 1, name: 'Show S1 E1 One', season: 1, episode: 1 });
  const tv = await playing({ videoId: 'tt5:1:1' }, 1300);
  io.meta = async () => show;
  io.streams = async () => ({ sources: [source('bbb')], queried: [], failed: [] });
  const p = cast.castNext(false);
  await flush(); started.at(-1)!.ready(); await flush();
  tv.loads.at(-1)!.resolve();
  await p; await cast.stop(false);
  const done = getProgress('tt5:1:1');
  assert.ok(done && done.dur > 0 && done.pos === done.dur, `finished, got ${done?.pos} of ${done?.dur}`);
});

test('markWatched: no record stays none, one without a duration becomes the marked-as-watched shape', () => {
  cast.markWatched('tt404:1:1');
  assert.equal(getProgress('tt404:1:1'), undefined);
  saveProgress({ videoId: 'tt405:1:1', metaId: 'tt405', type: 'series', pos: 300, dur: 0, updatedAt: 1, name: 'X' });
  cast.markWatched('tt405:1:1');
  assert.deepEqual([getProgress('tt405:1:1')?.pos, getProgress('tt405:1:1')?.dur], [1, 1]);
});

test('Next on the TV picks as the source list does: live seeders, and the show\'s running time', { timeout: 5000 }, async () => {
  const GB = 1024 ** 3;
  const next = async (sources: Source[], runtime?: string) => {
    const tv = await playing({ videoId: 'tt5:1:1' }, 100);
    io.meta = async () => ({ ...show, runtime }) as Meta;
    io.streams = async () => ({ sources, queried: [], failed: [] });
    const p = cast.castNext();
    await flush(); started.at(-1)!.ready(); await flush();
    tv.loads.at(-1)!.resolve();
    const s = await p; await cast.stop(false);
    return s.infoHash;
  };
  // The addon says 5000 for one and 40 for the other; the trackers say 0 and 300.
  trackerSeeds.set('loud', 0); trackerSeeds.set('quiet', 300);
  assert.equal(await next([{ ...source('loud'), seeders: 5000 }, { ...source('quiet'), seeders: 40 }]), 'quiet');
  // Equal swarms: 3 GB streams fine over a typical episode, not over a 20 minute one.
  const pair = () => [{ ...source('big'), sizeBytes: 3 * GB, seeders: 120 }, { ...source('small'), resolution: '720p' as const, sizeBytes: 0.6 * GB, seeders: 120 }];
  assert.equal(await next(pair()), 'big');
  assert.equal(await next(pair(), '20 min'), 'small');
});

test('seeks and subtitle shifts reuse the cast\'s subtitle list until the file completes', { timeout: 5000 }, async () => {
  const en: SubtitleTrack = { id: 'en1', lang: 'eng', label: 'English 1', origin: 'addon', url: '/api/subs/file/en1.vtt', available: true };
  let lookups = 0; let progress = 0.4;
  io.subtitles = async () => { lookups++; return [en]; };
  io.media = async (id: string) => ({ t: { infoHash: id, files: [{ name: 'film.mkv', progress }] }, idx: 0, local: `http://x/${id}`, probe: MKV }) as unknown as Awaited<ReturnType<typeof io.media>>;
  const tv = await playing({ subId: 'en1' });
  const restart = async (p: Promise<void>) => { await flush(); started.at(-1)!.ready(); await flush(); tv.loads.at(-1)!.resolve(); await p; };
  await restart(cast.seek(300));
  await restart(cast.setSubtitle('en1', 500));
  assert.equal(lookups, 1, 'one lookup for the first cast, none for the restarts');
  assert.deepEqual(cast.status().subs, [en]);
  assert.equal(cast.status().activeSubId, 'en1');
  assert.equal(cast.status().subOffsetMs, 500);
  progress = 1;   // complete: embedded tracks can be read now, so look again once
  await restart(cast.seek(600));
  await restart(cast.seek(900));
  assert.equal(lookups, 2);
  await restart(cast.castTo(req({ infoHash: 'bbb', videoId: 'tt2' })).then(() => undefined));
  assert.equal(lookups, 3, 'another file looks up its own');
});

test('a failed subtitle lookup is tried again on the next seek', { timeout: 5000 }, async () => {
  let lookups = 0;
  io.subtitles = async () => { lookups++; if (lookups === 1) throw new Error('addon down'); return []; };
  const tv = await playing();
  const p = cast.seek(300);
  await flush(); started.at(-1)!.ready(); await flush(); tv.loads.at(-1)!.resolve(); await p;
  assert.equal(lookups, 2);
});

// ---- subtitles picked while a seek or shift restarts the stream (3 to 4 s) ----
const EN: SubtitleTrack = { id: 'en1', lang: 'eng', label: 'English', origin: 'addon', url: '/api/subs/file/en1.vtt', available: true };
const NB: SubtitleTrack = { id: 'nb1', lang: 'nor', label: 'Norsk', origin: 'addon', url: '/api/subs/file/nb1.vtt', available: true };

test('subtitles turned off while a seek restarts: the restarted session loads without them, and a further press keeps that', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB];
  const tv = await playing({ videoId: 'tt60', subId: 'en1' });
  const first = cast.seek(300);
  await flush();                       // waiting for its first segment
  await cast.setSubtitle(null);
  assert.equal(cast.status().activeSubId, undefined, 'the status says so at once');
  assert.deepEqual(tv.tracks, [[]], 'the old media, still playing, shows it meanwhile');
  const second = cast.seek(400);
  await flush(); started.at(-1)!.ready(); await flush();
  assert.equal(tv.loads.length, 1);
  assert.deepEqual(tv.loads[0].ids, [], 'no subtitle in the restarted load');
  tv.loads[0].resolve(); await Promise.all([first, second]);
  assert.equal(cast.status().timeOffset, 400);
  assert.equal(cast.status().activeSubId, undefined);
  assert.equal(getProgress('tt60')?.subId, null, 'remembered as off');
});

test('a subtitle picked while the restarted session loads is switched to once the load is in', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB];
  const tv = await playing({ videoId: 'tt61', subId: 'en1' });
  const p = cast.seek(300);
  await flush(); started.at(-1)!.ready(); await flush();
  assert.deepEqual(tv.loads[0].ids, [1], 'the load went out with English');
  await cast.setSubtitle('nb1');
  assert.deepEqual(tv.tracks, [], 'nothing sent while the TV loads');
  assert.equal(cast.status().activeSubId, 'nb1');
  tv.loads[0].resolve(); await p;
  assert.deepEqual(tv.tracks, [[2]], 'Norsk once the load is in');
  assert.equal(cast.status().activeSubId, 'nb1');
  assert.equal(getProgress('tt61')?.subId, 'nb1');
});

test('a shift back while a subtitle shift restarts restarts again, to the offset asked last', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN];
  const tv = await playing({ videoId: 'tt62', subId: 'en1' });
  const a = cast.setSubtitle('en1', 500);
  await flush();
  const b = cast.setSubtitle('en1', 0);
  await flush(); started.at(-1)!.ready(); await flush();
  tv.loads.at(-1)!.resolve(); await Promise.all([a, b]);
  assert.equal(started.length, 3, 'the shift back is a restart too, not a track switch on the old media');
  assert.equal(cast.status().subOffsetMs, 0);
  assert.equal(cast.status().activeSubId, 'en1');
});

// ---- the subtitle remembered for a video, with nothing asked ----
const NB2: SubtitleTrack = { ...NB, id: 'nb2', label: 'Norsk 2', url: '/api/subs/file/nb2.vtt' };
const watched = (videoId: string, sub: { subId?: string | null; subLang?: string }) => saveProgress({ videoId, metaId: videoId, type: 'movie', pos: 100, dur: 3600, updatedAt: 1, name: 'Film', ...sub });

test('a saved language with no saved track: the first track in it, as in the browser, and remembered', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB, NB2];
  watched('tt70', { subLang: 'nor' });
  const p = cast.castTo(req({ videoId: 'tt70' }));
  await flush(); started[0].ready(); await flush();
  assert.deepEqual(tvs[0].loads[0].ids, [2], 'the load goes out with the first Norwegian track');
  tvs[0].loads[0].resolve(); await p;
  assert.equal(cast.status().activeSubId, 'nb1');
  assert.equal(getProgress('tt70')?.subId, 'nb1');
  assert.equal(getProgress('tt70')?.subLang, 'nor');
});

test('a saved track that is gone falls back to its language; subtitles saved as off stay off', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB2];
  watched('tt71', { subId: 'nb-old', subLang: 'nor' });
  await playing({ videoId: 'tt71' });
  assert.equal(cast.status().activeSubId, 'nb2');
  await cast.stop(false);
  watched('tt72', { subId: null, subLang: 'nor' });
  await playing({ videoId: 'tt72' });
  assert.equal(cast.status().activeSubId, undefined);
  assert.equal(getProgress('tt72')?.subId, null);
});

// ---- nothing asked or saved: Settings decides, as in the browser ----
/** Runs fn with these subtitle settings, then puts the ones before back. */
async function withSubSettings(s: { subLangs: string[]; autoSubs?: boolean }, fn: () => Promise<void>) {
  const was = { subLangs: getState().settings.subLangs, autoSubs: getState().settings.autoSubs };
  update((st) => { st.settings.subLangs = s.subLangs; st.settings.autoSubs = s.autoSubs; });
  try { await fn(); } finally { update((st) => { st.settings.subLangs = was.subLangs; st.settings.autoSubs = was.autoSubs; }); }
}

test('nothing asked or saved: the first track in the first language in Settings, and remembered', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB, NB2];
  watched('tt80', {});   // watched before, no subtitle choice saved
  await withSubSettings({ subLangs: ['nor', 'eng'] }, async () => {
    const p = cast.castTo(req({ videoId: 'tt80' }));
    await flush(); started[0].ready(); await flush();
    assert.deepEqual(tvs[0].loads[0].ids, [2], 'the load goes out with the first Norwegian track');
    tvs[0].loads[0].resolve(); await p;
    assert.equal(cast.status().activeSubId, 'nb1');
    assert.equal(getProgress('tt80')?.subId, 'nb1');
  });
});

test('automatic subtitles off, or no track in the first language in Settings: none, and nothing remembered', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB];
  await withSubSettings({ subLangs: ['eng'], autoSubs: false }, () => playing({ videoId: 'tt81' }).then(() => undefined));
  assert.equal(cast.status().activeSubId, undefined);
  assert.equal(getProgress('tt81')?.subId, undefined);
  await cast.stop(false);
  // Only the first language is tried, as in the browser.
  await withSubSettings({ subLangs: ['swe', 'eng'] }, () => playing({ videoId: 'tt82' }).then(() => undefined));
  assert.equal(cast.status().activeSubId, undefined);
  assert.equal(getProgress('tt82')?.subId, undefined);
});

test('asked off, saved off, or a saved language with no track in it: Settings turns nothing on', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB];
  watched('tt83', {});
  await playing({ videoId: 'tt83', subId: null });
  assert.equal(cast.status().activeSubId, undefined);
  assert.equal(getProgress('tt83')?.subId, null);
  await cast.stop(false);
  watched('tt84', { subId: null });
  await playing({ videoId: 'tt84' });
  assert.equal(cast.status().activeSubId, undefined);
  await cast.stop(false);
  watched('tt85', { subLang: 'swe' });
  await playing({ videoId: 'tt85' });
  assert.equal(cast.status().activeSubId, undefined);
});

test('Next after an episode without subtitles: the next one has nothing saved, so Settings picks', { timeout: 5000 }, async () => {
  io.subtitles = async () => [EN, NB];
  const tv = await playing({ videoId: 'tt6:1:1', subId: null }, 100);
  io.meta = async () => ({ ...show, id: 'tt6', videos: [{ id: 'tt6:1:1', season: 1, episode: 1, title: 'One' }, { id: 'tt6:1:2', season: 1, episode: 2, title: 'Two' }] }) as unknown as Meta;
  io.streams = async () => ({ sources: [source('bbb')], queried: [], failed: [] });
  const p = cast.castNext();
  await flush(); started[1].ready(); await flush();
  assert.deepEqual(tv.loads[0].ids, [1], 'English, the first language in Settings');
  tv.loads[0].resolve(); await p;
  assert.equal(cast.status().videoId, 'tt6:1:2');
  assert.equal(cast.status().activeSubId, 'en1');
});
