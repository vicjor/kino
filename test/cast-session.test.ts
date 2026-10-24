import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from 'castv2-client';
import { CastSession, onSocketClose, plainCastError, listenersAddedBy } from '../server/cast/session.ts';
import { withTimeout } from '../server/cast/timeout.ts';

// A receiver that never answers, like a Chromecast that went quiet mid-request.
const silent = { play() {}, pause() {}, stop() {}, seek() {}, load() {}, close() {}, media: { sessionRequest() {} } };
const withPlayer = (player: object) => { const s = new CastSession('127.0.0.1'); Object.assign(s, { player }); return s; };

test('CastSession commands give up after 8 s and loads after 90 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = withPlayer(silent);
  const pause = s.pause();
  t.mock.timers.tick(8000);
  await assert.rejects(pause, { message: 'Chromecast pause timed out after 8 s' });
  const load = s.load({ contentId: 'http://x/a.mp4', contentType: 'video/mp4', streamType: 'BUFFERED' }, {});
  t.mock.timers.tick(89_999);
  let settled = false; void load.catch(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(load, { message: 'Chromecast load timed out after 90 s' });
});

test('CastSession commands still pass answers and errors through', async () => {
  const s = withPlayer({ ...silent, play: (cb: (e: Error | null) => void) => cb(null), seek: (_t: number, cb: (e: Error | null) => void) => cb(new Error('Invalid request: INVALID_MEDIA_SESSION_ID')) });
  await s.play();
  await assert.rejects(s.seek(10), /INVALID_MEDIA_SESSION_ID/);
});

test('CastSession rejects at once when the session is closed, with a 503 in words', async () => {
  const s = withPlayer(silent);
  s.destroy();
  const gone = { message: 'Chromecast is not connected', status: 503 };
  await assert.rejects(s.play(), gone);
  await assert.rejects(s.setVolume({ level: 0.5 }), gone);
  await assert.rejects(s.load({ contentId: 'x', contentType: 'video/mp4', streamType: 'BUFFERED' }, {}), gone);
  await withTimeout(s.quit(), 100, 'quit');   // nothing to quit: no three second wait
});

test('closing the session fails the requests still waiting, at once', async () => {
  const s = withPlayer(silent);
  Object.assign(s, { client: { close() {}, setVolume() {} } });
  const load = s.load({ contentId: 'http://x/a.m3u8', contentType: 'application/vnd.apple.mpegurl', streamType: 'BUFFERED' }, {});
  const pause = s.pause(); const vol = s.setVolume({ level: 0.3 });
  s.destroy();
  await withTimeout(Promise.all([
    assert.rejects(load, { message: 'Chromecast connection closed', status: 502 }),
    assert.rejects(pause, { message: 'Chromecast connection closed', status: 502 }),
    assert.rejects(vol, { message: 'Chromecast connection closed', status: 502 }),
  ]), 100, 'rejections');
  assert.equal((s as unknown as { waiting: Set<unknown> }).waiting.size, 0);
});

test('answered and timed out requests leave nothing waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = withPlayer({ ...silent, play: (cb: (e: Error | null) => void) => cb(null) });
  await s.play();
  const pause = s.pause();
  t.mock.timers.tick(8000);
  await assert.rejects(pause, /timed out/);
  assert.equal((s as unknown as { waiting: Set<unknown> }).waiting.size, 0);
});

test('a TV that never answered reads as plain words, other errors pass through', () => {
  for (const m of ['Chromecast refused the stream: Chromecast load timed out after 90 s', 'Chromecast pause timed out after 8 s', 'Chromecast subtitle switch timed out after 8 s', 'Chromecast connect timeout', "Victor's TV pause timed out after 6 s", 'Kitchen speaker volume timed out after 0.5 s']) {
    const out = plainCastError(new Error(m)) as Error & { status?: number };
    assert.deepEqual([out.message, out.status], ['The TV did not answer', 504], m);
  }
  const other = new Error('Could not start the stream: Transcoder is still starting, retry');
  assert.equal(plainCastError(other), other);
  const refused = new Error('Chromecast refused the stream: Load failed');
  assert.equal(plainCastError(refused), refused);
});

test('a command the app on the TV turns down ("Invalid request: ...") is a 409 in words', () => {
  const said = (m: string) => { const out = plainCastError(new Error(m)) as Error & { status?: number }; return [out.status, out.message]; };
  assert.deepEqual(said('Invalid request: INVALID_MEDIA_SESSION_ID'), [409, 'What was playing on the TV has changed. Try again.']);
  for (const m of ['Invalid request: INVALID_COMMAND', 'Invalid request: NOT_SUPPORTED', 'Invalid request: INVALID_PARAMS', 'Invalid request: undefined', 'Invalid request: ']) {
    assert.deepEqual(said(m), [409, 'The app on the TV does not let Kino do that'], m);
  }
  // Only castv2-client's own text: wrapped in another sentence, or already carrying a status, it passes through.
  for (const e of [new Error('Chromecast refused the stream: Invalid request: INVALID_PARAMS'), Object.assign(new Error('Invalid request: x'), { status: 400 }), new Error('invalid request: lowercase')]) {
    assert.equal(plainCastError(e), e, e.message);
  }
});

// Stands in for castv2-client's Client: the test drives connect and launch by hand.
class FakeClient extends EventEmitter {
  client = new EventEmitter();   // the castv2 socket client the real one wraps
  closed = 0; connected?: () => void; launched?: (e: Error | null, p?: unknown) => void;
  connect(_o: unknown, cb: () => void) { this.connected = cb; }
  launch(_app: unknown, cb: (e: Error | null, p?: unknown) => void) { this.launched = cb; }
  close() { this.closed++; }
}
const fakePlayer = () => Object.assign(new EventEmitter(), { close: mock.fn(), getStatus() {} });
const connecting = () => { const s = new CastSession('127.0.0.1'); const c = new FakeClient(); Object.assign(s, { client: c }); const closed = mock.fn(); s.on('close', closed); return { s, c, closed }; };
const pollOf = (s: CastSession) => (s as unknown as { poll?: NodeJS.Timeout }).poll;

test('connect rejects on a socket error at once, not after a timeout, in words, and closes the client', async () => {
  const { s, c, closed } = connecting();
  const p = s.connect();
  c.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:8009'));
  await assert.rejects(p, { message: 'Kino could not reach the TV. Is it on and connected to this Wi-Fi?', status: 503 });
  assert.equal(c.closed, 1);
  assert.equal(closed.mock.callCount(), 1);
});

test('connect timeout closes the client, and a launch that answers late starts nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { s, c } = connecting();
  const p = s.connect();
  c.connected!();
  t.mock.timers.tick(10_000);
  await assert.rejects(p, { message: 'Chromecast connect timeout' });
  assert.equal(c.closed, 1);
  const late = fakePlayer();
  c.launched!(null, late);
  assert.equal(late.close.mock.callCount(), 1);
  assert.equal(pollOf(s), undefined);
});

test('a launch error closes the client and reads as words, not the receiver reason', async () => {
  for (const err of [new Error('Launch failed. Reason: NOT_ALLOWED'), null]) {   // null: no error and no player either
    const { s, c } = connecting();
    const p = s.connect();
    c.connected!();
    c.launched!(err);
    await assert.rejects(p, { message: 'Chromecast could not open its video player', status: 502 });
    assert.equal(c.closed, 1);
  }
});

test('a connected session polls without keeping the process alive', async () => {
  const { s, c } = connecting();
  const p = s.connect();
  c.connected!();
  c.launched!(null, fakePlayer());
  await p;
  assert.equal(pollOf(s)?.hasRef(), false);
  assert.equal(c.closed, 0);
  s.destroy();
});

test('a socket the TV closes cleanly ends the session, during connect or after', async () => {
  const a = connecting();
  const p = a.s.connect();
  a.c.client.emit('close');
  await assert.rejects(p, { message: 'Chromecast closed the connection', status: 502 });
  assert.equal(a.closed.mock.callCount(), 1);

  const b = connecting();
  const q = b.s.connect();
  b.c.connected!(); b.c.launched!(null, fakePlayer());
  await q;
  b.c.client.emit('close');
  assert.equal(b.closed.mock.callCount(), 1);
  await assert.rejects(b.s.pause(), { message: 'Chromecast is not connected', status: 503 });
});

test('onSocketClose finds the socket client inside the real castv2-client Client', () => {
  const c = new Client();
  const seen = mock.fn();
  onSocketClose(c, seen);
  (c as unknown as { client: EventEmitter }).client.emit('close');
  assert.equal(seen.mock.callCount(), 1);
});

/** A receiver whose media controller keeps a listener per status request until it is answered, like castv2-client's. */
function askedPlayer() {
  const media = new EventEmitter();
  const asks: ((e: Error | null, st: unknown) => void)[] = [];
  const p = Object.assign(new EventEmitter(), { media, close: mock.fn(), getStatus(cb: (e: Error | null, st: unknown) => void) {
    const l = () => {}; media.on('message', l);
    asks.push((e, st) => { media.removeListener('message', l); cb(e, st); });
  } });
  return { p, media, asks };
}

test('the status poll asks once at a time, gives up after 8 s and takes back the listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { s, c } = connecting();
  const { p, media, asks } = askedPlayer();
  const conn = s.connect(); c.connected!(); c.launched!(null, p); await conn;
  const seen = mock.fn(); s.on('status', seen);
  const step = async (ms: number) => { t.mock.timers.tick(ms); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  await step(2000);
  assert.equal(asks.length, 1);
  for (let i = 0; i < 4; i++) await step(2000);   // 10 s: three polls skipped while one waits, then it times out
  assert.equal(asks.length, 1, 'never more than one request waiting');
  assert.equal(media.listenerCount('message'), 0, 'the unanswered request leaves nothing behind');
  await step(2000);
  assert.equal(asks.length, 2, 'the next poll asks again');
  asks[1](null, { playerState: 'PLAYING', currentTime: 12, volume: { level: 1, muted: false } });
  await step(0);
  assert.equal(seen.mock.callCount(), 1);
  assert.equal(s.last?.currentTime, 12);
  await step(2000);
  assert.equal(asks.length, 3);
  s.destroy();
  await step(0);
  assert.equal(media.listenerCount('message'), 0, 'closing drops the one in flight too');
  asks[2](null, { playerState: 'PLAYING', currentTime: 20, volume: { level: 1, muted: false } });   // a late answer after close
  assert.equal(seen.mock.callCount(), 1);
});

test('listenersAddedBy removes only what the call added', () => {
  const em = new EventEmitter();
  const keep = () => {}; em.on('message', keep);
  const drop = listenersAddedBy(em, 'message', () => { em.on('message', () => {}); });
  assert.equal(em.listenerCount('message'), 2);
  drop();
  assert.deepEqual(em.listeners('message'), [keep]);
  listenersAddedBy(undefined, 'message', () => {})();   // no controller: nothing to do
});

/** A session whose receiver and app take each request like castv2-client (a 'message' listener on the channel it went out on) and never answer. */
function unanswering() {
  const media = new EventEmitter(); const receiver = new EventEmitter();
  const ask = (ch: EventEmitter) => () => { ch.on('message', () => {}); };
  const player = { media: Object.assign(media, { sessionRequest: ask(media) }), load: ask(media), play: ask(media), pause: ask(media), stop: ask(media), seek: ask(media), getStatus: ask(media), close() {} };
  const s = new CastSession('127.0.0.1');
  Object.assign(s, { player, client: { receiver, setVolume: ask(receiver), stop: ask(receiver), close() {} } });
  const count = () => [media.listenerCount('message'), receiver.listenerCount('message')];
  return { s, count };
}

test('timed out commands, loads, volume changes and quits take back their channel listener, and only theirs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { s, count } = unanswering();
  const cmds = [s.play(), s.pause(), s.stop(), s.seek(30), s.setTracks([1]), s.setVolume({ level: 0.5 })];
  assert.deepEqual(count(), [5, 1], 'media requests on the media channel, volume on the receiver channel');
  t.mock.timers.tick(4000);
  const later = s.pause();
  t.mock.timers.tick(4000);
  for (const c of cmds) await assert.rejects(c, /timed out after 8 s/);
  assert.deepEqual(count(), [1, 0], 'the pause sent 4 s later is still waiting: its listener stays');
  t.mock.timers.tick(4000);
  await assert.rejects(later, /timed out after 8 s/);
  assert.deepEqual(count(), [0, 0]);

  const load = s.load({ contentId: 'http://x/a.mp4', contentType: 'video/mp4', streamType: 'BUFFERED' }, {});
  assert.deepEqual(count(), [1, 0]);
  t.mock.timers.tick(90_000);
  await assert.rejects(load, /timed out after 90 s/);
  assert.deepEqual(count(), [0, 0]);

  const quit = s.quit();
  assert.deepEqual(count(), [0, 1]);
  t.mock.timers.tick(3000);
  await quit;
  assert.deepEqual(count(), [0, 0], 'quit gives up quietly after 3 s, its listener taken back');
});

test('closing the session takes back the listeners of requests still waiting', async () => {
  const { s, count } = unanswering();
  const reqs = [s.pause(), s.setVolume({ muted: true }), s.load({ contentId: 'http://x/a.mp4', contentType: 'video/mp4', streamType: 'BUFFERED' }, {})];
  assert.deepEqual(count(), [2, 1]);
  s.destroy();
  for (const r of reqs) await assert.rejects(r, { message: 'Chromecast connection closed' });
  assert.deepEqual(count(), [0, 0]);
});

test('an answered request leaves the channel as castv2-client left it', async () => {
  const media = new EventEmitter(); const other = () => {}; media.on('message', other);
  const answer = (cb: (e: Error | null) => void) => { const l = () => {}; media.on('message', l); media.removeListener('message', l); cb(null); };
  const s = withPlayer({ ...silent, media: Object.assign(media, { sessionRequest() {} }), play: answer });
  await s.play();
  assert.deepEqual(media.listeners('message'), [other]);
});
