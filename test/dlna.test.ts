import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { TestContext } from 'node:test';
import type { Torrent } from 'webtorrent';
import { _internal as d, io, kinoFile, stateOf, seenTitle, macFromArp, magicPacket, broadcasts, castTo, control, receiverInfo, setSubtitle, setVolume, status, stop } from '../server/cast/dlna.ts';
import type { Meta, Source, SubtitleTrack } from '../server/types.ts';
import { viaDlna } from '../server/cast/manager.ts';
import type { CastSession, RawStatus } from '../server/cast/session.ts';
import { api as castRoutes } from '../server/routes/cast.ts';
import { jsonErrors, statusOf, publicMessage } from '../server/errors.ts';
import { ensureDirs, DATA_DIR } from '../server/config.ts';
import { encodeSubId, decodeSubId, type SubKey } from '../server/subs/ids.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('DLNA time formats: HH:MM:SS both ways', () => {
  assert.equal(d.hms(0), '00:00:00');
  assert.equal(d.hms(120), '00:02:00');
  assert.equal(d.hms(3725.9), '01:02:05');
  assert.equal(d.secs('0:12:34'), 754);
  assert.equal(d.secs('01:02:05.500'), 3725);
  assert.equal(d.secs('NOT_IMPLEMENTED'), 0);
  assert.equal(d.secs(undefined), 0);
});

test('SOAP tag extraction tolerates prefixes and entities', () => {
  const xml = '<s:Body><u:GetPositionInfoResponse><RelTime>0:01:02</RelTime><TrackURI>http://x/a?b=1&amp;c=2</TrackURI></u:GetPositionInfoResponse></s:Body>';
  assert.equal(d.tag(xml, 'RelTime'), '0:01:02');
  assert.equal(d.tag(xml, 'TrackURI'), 'http://x/a?b=1&c=2');
  assert.equal(d.tag(xml, 'Missing'), undefined);
  assert.equal(d.esc('Tom & "Jerry" <3'), 'Tom &amp; &quot;Jerry&quot; &lt;3');
});

test('kinoFile finds our file in whatever the TV reports, on any host', () => {
  const h = '91e4011c3ee2b393d262a3f81aef95d3a7c60f0c';
  assert.deepEqual(kinoFile(`http://192.168.1.144:1234/api/file/${h}/0`), { infoHash: h, fileIdx: 0 });
  assert.deepEqual(kinoFile(`http://10.0.0.2:1234/api/file/${h.toUpperCase()}/3?x=1`), { infoHash: h, fileIdx: 3 });
  assert.equal(kinoFile('http://192.168.1.144:1234/api/hls/abc/index.m3u8'), undefined);
  assert.equal(kinoFile('http://other/movie.mkv'), undefined);
  assert.equal(kinoFile(undefined), undefined);
});

test('stateOf and seenTitle describe what another app plays', () => {
  assert.equal(stateOf('PLAYING'), 'PLAYING'); assert.equal(stateOf('PAUSED_PLAYBACK'), 'PAUSED');
  assert.equal(stateOf('TRANSITIONING'), 'BUFFERING'); assert.equal(stateOf('NO_MEDIA_PRESENT'), 'IDLE'); assert.equal(stateOf(undefined), 'IDLE');
  assert.equal(seenTitle('<DIDL-Lite><item><dc:title>Holiday clips</dc:title></item></DIDL-Lite>', 'http://x/a.mp4'), 'Holiday clips');
  assert.equal(seenTitle('', 'http://nas:8200/MediaItems/My%20Film.mkv?t=1'), 'My Film.mkv');
  assert.equal(seenTitle(undefined, undefined), undefined);
});

test('Wake-on-LAN: MAC from arp, magic packet, broadcast addresses', () => {
  assert.equal(macFromArp('? (192.168.1.74) at 0:1a:b:cc:d:ef on en0 ifscope [ethernet]'), '00:1a:0b:cc:0d:ef');
  assert.equal(macFromArp('? (192.168.1.74) at (incomplete) on en0 ifscope [ethernet]'), undefined);
  const p = magicPacket('00:1A:0B:CC:0D:EF');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  assert.equal(p.subarray(96).toString('hex'), '001a0bcc0def');
  assert.throws(() => magicPacket('nope'));
  const iface = (address: string, netmask: string, internal = false) => ({ address, netmask, internal, family: 'IPv4' as const, mac: '', cidr: null });
  assert.deepEqual(broadcasts({ en0: [iface('192.168.1.144', '255.255.255.0')], utun4: [iface('100.101.102.103', '255.255.255.255')], lo0: [iface('127.0.0.1', '255.0.0.0', true)] }), ['255.255.255.255', '192.168.1.255']);
});

let tvs = 0;
/**
 * A UPnP renderer on loopback, found by dlna.ts as SSDP would find it. It answers every AVTransport action it is not
 * told to fail, playing at 0:12:34, and notes each one (`calls`, with its body in `bodies`). `hold(action)` keeps that
 * action waiting from then on until `release(action)`, so a test can act while the TV is busy loading. `off()` turns it
 * off as Kino knows it then: gone from the network and from what SSDP found, remembered with a MAC to wake it by.
 */
async function fakeTv() {
  const id = `test-tv-${++tvs}`, name = `Test TV ${tvs}`;
  const calls: string[] = []; const bodies: string[] = []; const failing = new Set<string>();
  const holding = new Set<string>(); const held = new Map<string, (() => void)[]>();
  let power = true;
  const srv = http.createServer((req, res) => {
    if (!power) { req.socket.destroy(); return; }
    if (req.method === 'GET') { res.end(`<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${name}</friendlyName><UDN>uuid:${id}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></serviceList></device></root>`); return; }
    let body = '';
    req.setEncoding('utf8').on('data', (x: string) => { body += x; }).on('end', () => {
      const action = String(req.headers.soapaction).replace(/^"[^#]*#|"$/g, ''); calls.push(action); bodies.push(body);
      const answer = () => {
        if (failing.has(action)) { res.statusCode = 500; res.end('<errorCode>701</errorCode><errorDescription>Transition not available</errorDescription>'); return; }
        res.end(action === 'GetTransportInfo' ? '<CurrentTransportState>PLAYING</CurrentTransportState>' : action === 'GetPositionInfo' ? '<RelTime>0:12:34</RelTime><TrackDuration>1:00:00</TrackDuration>' : '<ok/>');
      };
      if (holding.has(action)) held.set(action, [...(held.get(action) || []), answer]); else answer();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await d.describe(`http://127.0.0.1:${port}/desc.xml`, '127.0.0.1');
  return {
    id: `dlna:${id}`, name, calls, bodies, failing,
    hold: (action: string) => { holding.add(action); },
    release: (action: string) => { holding.delete(action); for (const answer of held.get(action) || []) answer(); held.delete(action); },
    /** How many `action` calls are waiting on a hold. */
    waiting: (action: string) => held.get(action)?.length || 0,
    off: () => { power = false; d.renderers.delete(`dlna:${id}`); d.known.get(`dlna:${id}`)!.mac = '02:00:00:00:00:01'; },
    on: () => { power = true; },
    close: () => { d.renderers.delete(`dlna:${id}`); d.known.delete(`dlna:${id}`); srv.closeAllConnections(); return new Promise((r) => srv.close(r)); },
  };
}
/** Wait until `ok()`, 3 s at most. performance.now: a test may mock Date. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (const end = performance.now() + 3000; !ok();) { if (performance.now() > end) assert.fail(`still waiting for ${what}`); await new Promise((r) => setTimeout(r, 5)); }
}
/** The position polls dlna.ts started since `t.mock.method(globalThis, 'setInterval')`: every 2 s, the only 2 s interval it makes. */
const polls = (spy: { mock: { calls: { arguments: unknown[] }[] } }) => spy.mock.calls.filter((c) => c.arguments[1] === 2000).length;

test('a subtitle reload the TV refuses: the caller gets the error and the position poll keeps running', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  fakeIo(t);
  await castTo(film(tv.id));
  tv.failing.add('SetAVTransportURI');
  await assert.rejects(setSubtitle(null), { status: 502, message: 'The TV refused the command' });
  tv.calls.length = 0;
  t.mock.timers.tick(2000);
  await until(() => status().currentTime === 754, 'a poll after the failed reload');
  assert.ok(tv.calls.includes('GetPositionInfo'), `no poll after the failed reload: ${tv.calls.join(', ')}`);
});

test('a film stopped while the TV loads: no Play after the Stop, and no poll left behind', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  fakeIo(t);
  const spy = t.mock.method(globalThis, 'setInterval');
  tv.hold('SetAVTransportURI');
  const p = castTo(film(tv.id));
  await until(() => tv.waiting('SetAVTransportURI') === 1, 'the TV to get the stream');
  await stop(false);
  tv.release('SetAVTransportURI');
  assert.equal((await p).active, false);
  assert.deepEqual(tv.calls.filter((a) => a !== 'GetTransportInfo'), ['Stop', 'SetAVTransportURI', 'Stop'], 'the stale load pressed no Play after the Stop');
  assert.equal(polls(spy), 0, 'no position poll for a session that is gone');
});

test('two subtitle changes in a row: one load at a time, the later one plays, one poll left', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  fakeIo(t);
  await castTo(film(tv.id));
  const spy = t.mock.method(globalThis, 'setInterval');
  tv.calls.length = 0;
  tv.hold('SetAVTransportURI');
  const first = setSubtitle(null, 100);
  await until(() => tv.waiting('SetAVTransportURI') === 1, 'the first reload');
  const second = setSubtitle(null, 500);
  tv.release('SetAVTransportURI');
  await Promise.all([first, second]);
  assert.deepEqual(tv.calls, ['Stop', 'SetAVTransportURI', 'Stop', 'SetAVTransportURI', 'Play'], 'the earlier reload stopped before its Play');
  assert.equal(status().subOffsetMs, 500);
  assert.equal(polls(spy), 1);
});

/** What the phone reads for an error, after the manager's viaDlna: [status, words]. */
const answer = async (p: Promise<unknown>) => { const e = await viaDlna(() => p).then(() => assert.fail('no error'), (x: unknown) => x); return [statusOf(e), publicMessage(e)]; };
const film = (deviceId: string) => ({ deviceId, infoHash: 'a'.repeat(40), fileIdx: -1, title: 'Film' });

test('DLNA failures reach the phone in words: 404 no such TV, 503 off, 409 no volume control, 502 refused', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  fakeIo(t);
  const NOT_FOUND = [404, 'TV not found. Is it on and connected to this Wi-Fi?'];
  assert.deepEqual(await answer(castTo(film('dlna:nope'))), NOT_FOUND);
  assert.deepEqual(await answer(control('dlna:nope', 'pause')), [404, 'TV not found']);
  assert.deepEqual(await answer(setVolume('dlna:nope', { level: 0.5 })), [404, 'TV not found']);
  assert.deepEqual(await answer(setVolume(tv.id, { level: 0.5 })), [409, 'This TV has no volume control Kino can use']);
  tv.failing.add('Pause');
  assert.deepEqual(await answer(control(tv.id, 'pause')), [502, 'The TV refused the command']);
  tv.failing.add('SetAVTransportURI');
  assert.deepEqual(await answer(castTo(film(tv.id))), [502, `${tv.name} refused the stream`]);
  assert.equal(status().active, false);
  // Off the network and never woken by Kino: no MAC to wake it with.
  d.renderers.delete(tv.id); d.known.get(tv.id)!.mac = undefined;
  assert.deepEqual(await answer(castTo(film(tv.id))), [503, `${tv.name} is off. Turn it on with the remote this once, and Kino can turn it on by itself after that.`]);
});

test('the cast routes hand a DLNA refusal to the phone with its words', async (t) => {
  const tv = await fakeTv();
  const app = express().use(express.json()).use('/api', castRoutes).use(jsonErrors);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  t.after(async () => { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); await tv.close(); });
  const post = async (p: string, body: unknown) => { const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  tv.failing.add('Pause');
  assert.deepEqual(await post(`/cast/receivers/${tv.id}/pause`, {}), [502, { error: 'The TV refused the command' }]);
  assert.deepEqual(await post(`/cast/receivers/${tv.id}/volume`, { level: 0.5 }), [409, { error: 'This TV has no volume control Kino can use' }]);
});

/** dlna.io for a test: a film with no subtitles and no wait longer than a few ms, wake packets counted, not sent. */
function fakeIo(t: TestContext, more: Partial<typeof io> = {}) {
  const saved = { ...io }; t.after(() => { Object.assign(io, saved); });
  const wakes: string[] = [];
  Object.assign(io, {
    media: async (infoHash: string) => ({ t: { infoHash, files: [{ name: 'film.mkv' }] } as unknown as Torrent, idx: 0 }),
    probe: async () => ({ duration: 3600 }),
    subtitles: async () => [],
    wake: async (mac: string) => { wakes.push(mac); },
    wait: () => new Promise<void>((r) => setTimeout(r, 2)),
    ...more,
  });
  return wakes;
}

test('a cast that cannot start wakes no TV: the torrent check comes first', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  const wakes = fakeIo(t, { media: async () => { throw Object.assign(new Error('No video file in this torrent'), { status: 400 }); } });
  tv.off();
  assert.deepEqual(await answer(castTo(film(tv.id))), [400, 'No video file in this torrent']);
  assert.deepEqual([wakes.length, tv.calls.length, receiverInfo(tv.id)?.waking], [0, 0, false]);
});

test('a TV that is off is woken while the film gets ready, and plays once it answers', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  const wakes = fakeIo(t);
  io.wake = async (mac) => { wakes.push(mac); tv.on(); };
  tv.off();
  const s = await castTo(film(tv.id));
  assert.deepEqual([s.active, s.deviceId, wakes], [true, tv.id, ['02:00:00:00:00:01']]);
  assert.deepEqual(tv.calls.filter((a) => a !== 'GetTransportInfo'), ['Stop', 'SetAVTransportURI', 'Play']);
});

/** A wait the test steps by hand (`steps.shift()!()`), cut short when its signal aborts, as io.wait is. */
const stepped = (steps: (() => void)[]) => (_ms: number, signal?: AbortSignal) => new Promise<void>((r) => { steps.push(r); signal?.addEventListener('abort', () => r(), { once: true }); });
const fast = () => new Promise<void>((r) => setTimeout(r, 2));

test('a cancelled cast stops waiting for the TV at once: its wait cut short, no more wake packets, nothing sent to it', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  const steps: (() => void)[] = [];
  const wakes = fakeIo(t, { wait: stepped(steps) });
  tv.off();
  const cancel = new AbortController();
  const p = castTo(film(tv.id), { signal: cancel.signal });
  await until(() => steps.length === 1, 'the wake to wait');
  cancel.abort();
  assert.equal((await p).active, false);
  await until(() => receiverInfo(tv.id)?.waking === false, 'the wake to stop without its wait running out');
  assert.deepEqual([wakes.length, tv.calls.length], [1, 0]);
});

test('two casts waiting on one TV share one wake: it goes on while one of them waits, and stops once neither does', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  const steps: (() => void)[] = [];
  const wakes = fakeIo(t, { wait: stepped(steps) });
  tv.off();
  const [a, b] = [new AbortController(), new AbortController()];
  const first = castTo(film(tv.id), { signal: a.signal }), second = castTo(film(tv.id), { signal: b.signal });
  await until(() => steps.length === 1, 'the wake to wait');
  a.abort();
  assert.equal((await first).active, false, 'the one called off leaves at once');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([wakes.length, steps.length, receiverInfo(tv.id)?.waking], [1, 1, true], 'one wake, one packet, going on for the other');
  b.abort();
  assert.equal((await second).active, false);
  await until(() => receiverInfo(tv.id)?.waking === false, 'the wake to stop');
  assert.equal(wakes.length, 1);
});

test('a TV that never comes back: a 503 in words after 90 s', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const wakes = fakeIo(t, { wait: async (ms) => { t.mock.timers.tick(ms); } });
  tv.off();
  assert.deepEqual(await answer(castTo(film(tv.id))), [503, `${tv.name} did not turn on. Check that "Turn on via Wi-Fi" is on in the TV's settings.`]);
  assert.equal(wakes.length, 9, 'one wake packet every 10 s');
  assert.equal(receiverInfo(tv.id)?.waking, false);
});

test('two subtitle picks in a row on a film: the TV ends up with the later one', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await stop(false); await tv.close(); });
  const track = (id: string, lang: string): SubtitleTrack => ({ id, lang, label: lang, origin: 'addon', url: `/api/subs/file/${id}.vtt`, available: true });
  fakeIo(t, { subtitles: async () => [track('en1', 'eng'), track('fr1', 'fre')] });
  await castTo(film(tv.id));
  tv.calls.length = 0; tv.bodies.length = 0;
  tv.hold('SetAVTransportURI');
  const first = setSubtitle('en1');
  await until(() => tv.waiting('SetAVTransportURI') === 1, 'the first reload');
  const second = setSubtitle('fr1');
  tv.release('SetAVTransportURI');
  await Promise.all([first, second]);
  assert.deepEqual(tv.calls, ['Stop', 'SetAVTransportURI', 'Stop', 'SetAVTransportURI', 'Play']);
  const uris = tv.bodies.filter((b) => b.includes('SetAVTransportURI'));
  assert.match(uris[1], /fr1\.srt/, 'the reload that played carries the later pick');
  assert.equal(status().activeSubId, 'fr1');
});

/** A promise the test opens: `open()` lets whatever waits on `wait` go on. */
function gate() { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; }

test('a cast that lost while its TV woke takes over nothing: what plays elsewhere plays on, the woken TV gets no load', async (t) => {
  const [a, b] = [await fakeTv(), await fakeTv()];
  t.after(async () => { await stop(false); await a.close(); await b.close(); });
  let settled = false;
  // The TV wakes at the first packet; the wait after it answers is the wake's last step.
  fakeIo(t, { wake: async () => { b.on(); }, wait: async (ms) => { await new Promise((r) => setTimeout(r, 2)); if (ms === 3000) settled = true; } });
  await castTo(film(a.id));
  a.calls.length = 0;
  const subs = gate();
  io.subtitles = async () => { await subs.wait; return []; };
  b.off();
  const newer = new AbortController();
  const p = castTo(film(b.id), { signal: newer.signal });
  await until(() => settled, 'the TV to wake');
  newer.abort();   // the newer command lands after the wake, while the subtitle lookup still runs
  subs.open();
  assert.equal((await p).deviceId, a.id);
  assert.deepEqual(a.calls.filter((x) => x !== 'GetTransportInfo' && x !== 'GetPositionInfo'), [], 'no Stop for what plays');
  assert.deepEqual(b.calls.filter((x) => x !== 'GetTransportInfo'), [], 'nothing loaded on the woken TV');
});

test('the manager hands its cancellation to a DLNA start: a stop while the start works leaves nothing playing', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const [a, b] = [await fakeTv(), await fakeTv()];
  t.after(async () => { await cast.stop(false); await a.close(); await b.close(); });
  fakeIo(t);
  await cast.castTo(film(a.id));
  assert.equal(cast.status().deviceId, a.id);
  const subs = gate();
  io.subtitles = async () => { await subs.wait; return []; };
  const p = cast.castTo(film(b.id));
  await new Promise((r) => setTimeout(r, 20));
  await cast.stop(false);
  subs.open();
  assert.equal((await p).active, false);
  assert.equal(cast.status().active, false);
  assert.deepEqual(b.calls, [], 'the TV the stopped start meant got nothing');
});

test('a TV that is off and gone from SSDP is still a cast target: the manager lets Kino wake it', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const tv = await fakeTv();
  t.after(async () => { await cast.stop(false); await tv.close(); });
  const wakes = fakeIo(t);
  io.wake = async (mac) => { wakes.push(mac); tv.on(); };
  tv.off();
  const s = await cast.castTo(film(tv.id));
  assert.deepEqual([s.active, s.deviceId, wakes.length], [true, tv.id, 1]);
  await assert.rejects(cast.castTo(film('dlna:never-seen')), { status: 404, message: 'TV not found. Is it on and connected to this Wi-Fi?' });
});

test('Next on a DLNA TV ranks its sources for a screen that decodes HEVC and HDR itself: the lean HEVC release wins', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const scrape = await import('../server/scrape.ts');
  const tv = await fakeTv();
  const saved = { ...cast.io };
  t.after(async () => { await cast.stop(false); Object.assign(cast.io, saved); scrape.setScrapeForTests(null); await tv.close(); });
  fakeIo(t);
  scrape.setScrapeForTests(async (hashes) => new Map(hashes.map((h) => [h, 400])));
  const src = (infoHash: string, codec: 'h264' | 'hevc'): Source => ({ id: `${infoHash}:0`, infoHash, fileIdx: 0, addon: 'T', releaseName: `Show.S01E02.1080p.WEB-DL.${codec}`, seeders: 400, sizeBytes: 2 * 1024 ** 3, resolution: '1080p', codec, sourceTag: 'WEB-DL', score: 0, warnings: [] });
  const [h264, hevc] = ['b'.repeat(40), 'c'.repeat(40)];
  cast.io.meta = async () => ({ id: 'tt5', type: 'series', name: 'Show', videos: [{ id: 'tt5:1:1', season: 1, episode: 1 }, { id: 'tt5:1:2', season: 1, episode: 2 }] }) as unknown as Meta;
  cast.io.streams = async () => ({ sources: [src(h264, 'h264'), src(hevc, 'hevc')], queried: [], failed: [] });
  await cast.castTo({ ...film(tv.id), videoId: 'tt5:1:1' });
  const s = await cast.castNext(false);
  assert.deepEqual([s.deviceId, s.videoId, s.infoHash], [tv.id, 'tt5:1:2', hevc], 'ranked as a browser with no caps, the H.264 one would win');
});

// ---- what Kino keeps on disk about renderers and the casts asked for ----
const HOUR = 3600_000;
/** A cast as dlna-asked.json holds it, `at` ms ago, with three subtitle tracks: the ids given, English active. */
function askedEntry(ago: number, en: string, nor: string) {
  const track = (id: string, lang: string): SubtitleTrack => ({ id, lang, label: lang, origin: 'torrent', url: `/api/subs/file/${id}.vtt`, available: true });
  return { req: { deviceId: 'dlna:x', infoHash: 'a'.repeat(40), fileIdx: 0, title: 'Film', subId: en }, duration: 3600, type: 'movie', tracks: [track(en, 'eng'), track(nor, 'nor'), track('junk', 'swe')], activeSubId: en, subOffsetMs: 0, fileName: 'film.mkv', at: Date.now() - ago };
}
const EN: SubKey = { o: 't', h: 'a'.repeat(40), i: 2 };
/** An id as Kino wrote it before ids were signed: the bare payload. */
const bare = (k: SubKey) => Buffer.from(JSON.stringify(k)).toString('base64url');

test('dlna-asked.json as loaded: casts over 12 hours old go, ids from before signing are re-signed with their URLs, unreadable ones go with their track', () => {
  const root = crypto.randomBytes(32);
  const nor = encodeSubId({ o: 't', h: 'a'.repeat(40), i: 3 }, root);
  const out = d.freshAsked({ fresh: askedEntry(HOUR, bare(EN), nor), old: askedEntry(13 * HOUR, bare(EN), nor), gone: null, noReq: { at: Date.now() }, oddReq: { req: 'x', at: Date.now() } }, Date.now(), root);
  assert.deepEqual([...out.keys()], ['fresh']);
  const a = out.get('fresh')!, en = encodeSubId(EN, root);
  assert.deepEqual(a.tracks.map((t) => [t.id, t.url]), [[en, `/api/subs/file/${en}.vtt`], [nor, `/api/subs/file/${nor}.vtt`]], 'signed by this install: kept as is');
  assert.deepEqual([a.activeSubId, a.req.subId], [en, en]);
  assert.deepEqual(decodeSubId(a.activeSubId!, root), EN, 'one the subtitle route serves');
  assert.deepEqual([a.req.title, a.fileName, a.duration], ['Film', 'film.mkv', 3600]);
});

test('dlna-asked.json is pruned and re-signed on load and written back whole; dlna-known.json is written whole too', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-asked-'));
  t.after(() => { d.asked.clear(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = crypto.randomBytes(32);
  const file = path.join(dir, 'dlna-asked.json');
  fs.writeFileSync(file, JSON.stringify({ fresh: askedEntry(HOUR, bare(EN), 'junk2'), old: askedEntry(13 * HOUR, bare(EN), 'junk2') }));
  d.loadAsked(file, root);
  assert.deepEqual([...d.asked.keys()], ['fresh']);
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([Object.keys(back), back.fresh.activeSubId], [['fresh'], encodeSubId(EN, root)]);
  assert.deepEqual(fs.readdirSync(dir), ['dlna-asked.json'], 'no temporary file left');
  d.loadAsked(path.join(dir, 'missing.json'), root);
  assert.deepEqual([...d.asked.keys()], ['fresh'], 'no file: nothing changes');
});

test('dlna-known.json is written whole (temporary file, then rename) and private', async (t) => {
  const tv = await fakeTv();
  t.after(async () => { await tv.close(); });
  const file = path.join(DATA_DIR, 'dlna-known.json');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8'))[tv.id], 'the renderer found is remembered');
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

/** A Chromecast connection for the manager: every LOAD lands at once; it counts how it was let go. */
class MiniCast extends EventEmitter {
  stops = 0; quits = 0; closed = false;
  load() { return Promise.resolve(); }
  setTracks() { return Promise.resolve(); }
  stop() { this.stops++; return Promise.resolve(); }
  quit() { this.quits++; return Promise.resolve(); }
  destroy() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  report(s: Partial<RawStatus>) { this.emit('status', { state: 'PLAYING', currentTime: 0, volume: 1, muted: false, activeTrackIds: [], ...s }); }
}
type Manager = typeof import('../server/cast/manager.ts');
/** The manager's io with one Chromecast, "living", that plays an MP4 as is (no ffmpeg). Its connections, newest last. */
function fakeCast(t: TestContext, cast: Manager): MiniCast[] {
  ensureDirs();   // the disk check before a Chromecast start reads the cache folder
  const saved = { ...cast.io }; t.after(() => { Object.assign(cast.io, saved); });
  const sessions: MiniCast[] = [];
  const mp4 = { container: 'mp4', duration: 3600, video: { codec: 'h264', height: 1080 }, audio: [{ index: 1, codec: 'aac' }], subs: [] };
  Object.assign(cast.io, {
    device: (id: string) => (id === 'living' ? { id, name: 'Living', model: 'Chromecast', host: '10.0.0.9', port: 8009, audioOnly: false } : undefined),
    media: async (id: string) => ({ t: { infoHash: id, files: [{ name: 'film.mp4', progress: 1 }] }, idx: 0, local: `http://x/${id}`, probe: mp4 }),
    subtitles: async () => [],
    connect: async () => { const s = new MiniCast(); sessions.push(s); return s as unknown as CastSession; },
  });
  return sessions;
}
/** A Chromecast cast playing on "living", 100 s in. Its connection. */
async function castingOnLiving(t: TestContext, cast: Manager, videoId?: string): Promise<MiniCast> {
  const sessions = fakeCast(t, cast);
  await cast.castTo({ ...film('living'), videoId });
  sessions[0].report({ currentTime: 100 });
  return sessions[0];
}
const playsOn = (cast: Manager, cc: MiniCast) => [cast.status().deviceId, cast.status().state, cc.stops, cc.quits, cc.closed];
const PLAYS_ON = ['living', 'PLAYING', 0, 0, false];

test('casting to a sleeping TV: the Chromecast plays on while it wakes, and is let go only once the TV answers', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const tv = await fakeTv();
  t.after(async () => { await cast.stop(false); await tv.close(); });
  const cc = await castingOnLiving(t, cast);
  const steps: (() => void)[] = [];
  fakeIo(t, { wait: stepped(steps) });
  tv.off();
  const p = cast.castTo(film(tv.id));
  await until(() => steps.length === 1, 'the wake');
  assert.deepEqual(playsOn(cast, cc), PLAYS_ON, 'plays on while the TV wakes');
  tv.on(); io.wait = fast; steps.shift()!();
  const s = await p;
  assert.deepEqual([s.deviceId, cc.quits, cc.closed], [tv.id, 1, true], 'let go once the TV answered');
});

test('a sleeping TV that never turns on ends nothing: the Chromecast cast plays on', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const tv = await fakeTv();
  t.after(async () => { await cast.stop(false); await tv.close(); });
  const cc = await castingOnLiving(t, cast);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  fakeIo(t, { wait: async (ms) => { t.mock.timers.tick(ms); } });
  tv.off();
  const OFF = [503, `${tv.name} did not turn on. Check that "Turn on via Wi-Fi" is on in the TV's settings.`];
  assert.deepEqual(await answer(cast.castTo(film(tv.id))), OFF);
  assert.deepEqual(playsOn(cast, cc), PLAYS_ON);
});

test('a Chromecast episode that ends while the TV wakes queues no next episode there: the TV takes over', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const tv = await fakeTv();
  t.after(async () => { await cast.stop(false); await tv.close(); });
  const cc = await castingOnLiving(t, cast, 'tt5:1:1');
  let asked = 0;
  cast.io.meta = async () => { asked++; throw new Error('not in this test'); };
  const steps: (() => void)[] = [];
  fakeIo(t, { wait: stepped(steps) });
  tv.off();
  const p = cast.castTo(film(tv.id));
  await until(() => steps.length === 1, 'the wake');
  cc.report({ state: 'IDLE', idleReason: 'FINISHED', currentTime: 3600 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked, 0, 'no next episode looked up for the Chromecast');
  tv.on(); io.wait = fast; steps.shift()!();
  assert.equal((await p).deviceId, tv.id);
});

test('a cast that replaces another for the same sleeping TV waits on the same wake, which goes on', async (t) => {
  const cast = await import('../server/cast/manager.ts');
  const tv = await fakeTv();
  t.after(async () => { await cast.stop(false); await tv.close(); });
  const steps: (() => void)[] = [];
  const wakes = fakeIo(t, { wait: stepped(steps) });
  tv.off();
  const first = cast.castTo(film(tv.id));
  await until(() => steps.length === 1, 'the wake');
  const other = 'b'.repeat(40);
  const second = cast.castTo({ ...film(tv.id), infoHash: other });
  assert.equal((await first).active, false);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([wakes.length, steps.length, receiverInfo(tv.id)?.waking], [1, 1, true], 'one wake, not begun again');
  tv.on(); io.wait = fast; steps.shift()!();
  const s = await second;
  assert.deepEqual([s.deviceId, s.infoHash], [tv.id, other]);
});
