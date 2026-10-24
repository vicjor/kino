import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Client, ReceiverStatus } from 'castv2-client';
import type { CastDevice } from '../server/types.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
process.env.LOG_LEVEL = 'warn';
const { _Watcher, watchdogAction, command } = await import('../server/cast/monitor.ts');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// Stands in for castv2-client's Client: the test answers connect and every status request by hand.
class FakeCast extends EventEmitter {
  client = new EventEmitter();   // the castv2 socket client the real one wraps
  closed = 0; connected?: () => void;
  asks: ((e: Error | null, st: ReceiverStatus) => void)[] = [];
  connect(_o: unknown, cb: () => void) { this.connected = cb; }
  getStatus(cb: (e: Error | null, st: ReceiverStatus) => void) { this.asks.push(cb); }
  close() { this.closed++; }
}
const idle: ReceiverStatus = { volume: { level: 0.4, muted: false }, applications: [] };
const dev: CastDevice = { id: 'tv1', name: 'Living room TV', model: 'Chromecast', host: '192.0.2.10', port: 8009, audioOnly: false };
const flush = () => new Promise<void>((r) => setImmediate(r));

function watch() {
  const made: FakeCast[] = [];
  const w = new _Watcher(dev, () => { const c = new FakeCast(); made.push(c); return c as unknown as Client; });
  return { w, made };
}

test('watchdogAction: quiet for 10 s gets a probe, silent for 30 s a new connection', () => {
  assert.equal(watchdogAction(9_999, 0), 'ok');
  assert.equal(watchdogAction(10_000, 0), 'probe');
  assert.equal(watchdogAction(29_999, 0), 'probe');
  assert.equal(watchdogAction(30_000, 0), 'reconnect');
});

test('a connected device that goes silent is reconnected and keeps its entry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { w, made } = watch();
  made[0].connected!(); made[0].asks.shift()!(null, idle);
  assert.equal(w.info.online, true);
  const at = async (ms: number) => { t.mock.timers.tick(ms); await flush(); w.check(Date.now()); };

  await at(5_000);
  assert.equal(made[0].asks.length, 0, 'heard 5 s ago: leave it alone');
  await at(5_000);
  assert.equal(made[0].asks.length, 1, 'quiet 10 s: ask for a status');
  made[0].asks.shift()!(null, idle); await flush();
  assert.equal(w.lastHeard, 10_000, 'an answer resets the clock');

  await at(10_000);   // 20 s: quiet 10 s, probe
  await at(5_000);    // 25 s: that probe is still in flight, no second one
  assert.equal(made[0].asks.length, 1);
  await at(5_000);    // 30 s: first probe timed out at 26 s, ask again
  assert.equal(made[0].asks.length, 2);
  assert.equal(made[0].closed, 0);
  await at(10_000);   // 40 s: silent for 30 s
  assert.equal(made[0].closed, 1);
  assert.equal(w.info.online, false);
  assert.equal(w.dead, false);
  assert.equal(w.info.name, 'Living room TV');

  t.mock.timers.tick(5_000);   // reconnect backoff
  assert.equal(made.length, 2);
  made[0].asks.forEach((k) => k(null, idle));   // a late answer on the dropped socket changes nothing
  assert.equal(w.info.online, false);
  made[1].connected!(); made[1].asks.shift()!(null, idle);
  assert.equal(w.info.online, true);
  w.destroy();
});

test('a device that connects but never sends its first status is retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { w, made } = watch();
  made[0].connected!();
  assert.equal(made[0].asks.length, 1);
  t.mock.timers.tick(7_999);
  assert.equal(made[0].closed, 0);
  t.mock.timers.tick(1);
  assert.equal(made[0].closed, 1);
  t.mock.timers.tick(5_000);
  assert.equal(made.length, 2, 'a fresh connection after the backoff');
  w.destroy();
});

test('a status event before the first answer counts as connected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { w, made } = watch();
  made[0].connected!();
  made[0].emit('status', idle);
  t.mock.timers.tick(8_000);
  assert.equal(made[0].closed, 0);
  assert.equal(w.info.online, true);
  w.destroy();
});

test('a closed socket drops the connection once and reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { w, made } = watch();
  made[0].connected!(); made[0].asks.shift()!(null, idle);
  made[0].client.emit('close');
  made[0].emit('error', new Error('read ECONNRESET'));
  assert.equal(made[0].closed, 1);
  assert.equal(w.info.online, false);
  t.mock.timers.tick(5_000);
  assert.equal(made.length, 2);
  w.destroy();
});

/**
 * Like FakeCast, but each request leaves a 'message' listener on its channel until answered, as castv2-client's do:
 * receiver requests (status, volume, stop) on `receiver`, the joined app's on `media`. Only the first status gets an answer.
 */
class ListeningCast extends FakeCast {
  receiver = new EventEmitter();
  media = new EventEmitter();
  app = Object.assign(new EventEmitter(), { media: this.media, close() {}, getStatus: this.wait(this.media), pause: this.wait(this.media), play: this.wait(this.media), seek: this.wait(this.media) });
  wait(ch: EventEmitter) { return () => { ch.on('message', () => {}); }; }
  override getStatus(cb: (e: Error | null, st: ReceiverStatus) => void) { const l = () => {}; this.receiver.on('message', l); this.asks.push((e, st) => { this.receiver.removeListener('message', l); cb(e, st); }); }
  setVolume() { this.receiver.on('message', () => {}); }
  stop() { this.receiver.on('message', () => {}); }
  join(_app: unknown, _App: unknown, cb: (e: Error | null, p: unknown) => void) { cb(null, this.app); }
}
/** A command the device never answers: a 504 in words, not "Living room TV pause timed out after 6 s". */
const noAnswer = { status: 504, message: 'The TV did not answer' };
const casting: ReceiverStatus ={ volume: { level: 0.4, muted: false }, applications: [{ appId: 'APP1', displayName: 'Some app', sessionId: 's1', transportId: 't1', namespaces: [{ name: 'urn:x-cast:com.google.cast.media' }] }] };

test('probes, media polls and commands the device never answers take back their channel listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const made: ListeningCast[] = [];
  const w = new _Watcher(dev, () => { const c = new ListeningCast(); made.push(c); return c as unknown as Client; });
  const c = made[0];
  const count = () => [c.receiver.listenerCount('message'), c.media.listenerCount('message')];
  const at = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  c.connected!(); c.asks.shift()!(null, casting);
  assert.deepEqual(count(), [0, 1], 'joined the app and asked for its media status');
  await at(6_000);
  assert.deepEqual(count(), [0, 0], 'the media status nobody answered is taken back');
  await at(2_000);   // 8 s: the next media poll
  const pause = assert.rejects(w.command('pause', {}), noAnswer);
  const vol = assert.rejects(w.command('volume', { level: 0.2 }), noAnswer);
  assert.deepEqual(count(), [1, 2]);
  await at(2_000); w.check(Date.now());   // 10 s quiet: a receiver status probe
  assert.deepEqual(count(), [2, 2]);
  await at(4_000);   // 14 s: the poll, pause and volume time out, the probe still waits
  await pause; await vol;
  assert.deepEqual(count(), [1, 0]);
  await at(2_000);   // 16 s: the probe times out, another media poll goes out
  assert.deepEqual(count(), [0, 1]);
  const stop = assert.rejects(w.command('stop', {}), noAnswer);
  assert.deepEqual(count(), [1, 1]);
  await at(6_000);
  await stop;
  assert.deepEqual(count(), [0, 0], 'nothing left behind on a connection that stays open');
  assert.equal(c.closed, 0);
  w.destroy();
});

test('a command the app on the device turns down ("Invalid request: ...") is a 409 in words, not the generic sentence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const made: ListeningCast[] = [];
  const w = new _Watcher(dev, () => { const c = new ListeningCast(); made.push(c); return c as unknown as Client; });
  const c = made[0];
  c.connected!(); c.asks.shift()!(null, casting);
  type Cb = (e: Error | null) => void;
  Object.assign(c.app, { seek: (_t: number, k: Cb) => k(new Error('Invalid request: INVALID_COMMAND')), pause: (k: Cb) => k(new Error('Invalid request: INVALID_MEDIA_SESSION_ID')) });
  await assert.rejects(w.command('seek', { time: 60 }), { status: 409, message: 'The app on the TV does not let Kino do that' });
  await assert.rejects(w.command('pause', {}), { status: 409, message: 'What was playing on the TV has changed. Try again.' });
  assert.equal(w.info.online, true, 'the device stays connected');
  w.destroy();
});

test('a command for a device Kino does not know is a 404, Cast or DLNA', async () => {
  await assert.rejects(command('nope', 'pause'), { status: 404, message: 'Cast device not found' });
  await assert.rejects(command('dlna:nope', 'volume', { level: 0.5 }), { status: 404, message: 'TV not found' });
  await assert.rejects(command('dlna:nope', 'stop'), { status: 404, message: 'TV not found' });
});

test('a command to a device that is offline is a 503; with nothing controllable playing, a 409', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { w, made } = watch();
  await assert.rejects(w.command('pause', {}), { status: 503, message: 'Living room TV is offline' });
  made[0].connected!(); made[0].asks.shift()!(null, idle);
  assert.equal(w.info.online, true);
  for (const cmd of ['pause', 'play', 'seek'] as const) await assert.rejects(w.command(cmd, { time: 5 }), { status: 409, message: 'Nothing controllable is playing' }, cmd);
  w.destroy();
});
