import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pinToken, sameSecret, cookieValues, attemptLimiter, attemptKey, pinAttempts, pinOpen, pauseText, shortPin, LONG_PAUSE_MS } from '../server/pin.ts';

const ROOT = Buffer.alloc(32, 7);

test('pin token: stable for one PIN and secret, changes with either, not the old unsalted hash', () => {
  const t = pinToken('1234', ROOT);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(pinToken('1234', ROOT), t);
  assert.notEqual(pinToken('1235', ROOT), t);
  assert.notEqual(pinToken('1234', Buffer.alloc(32, 8)), t);
  assert.notEqual(t, crypto.createHash('sha256').update('kino-pin:1234').digest('hex'));
});

test('sameSecret: equal strings only, any lengths', () => {
  assert.equal(sameSecret('1234', '1234'), true);
  assert.equal(sameSecret('1234', '1235'), false);
  assert.equal(sameSecret('123', '1234'), false);
  assert.equal(sameSecret('', '1234'), false);
  assert.equal(sameSecret('', ''), true);
});

test('cookieValues: every value for the name, others ignored', () => {
  assert.deepEqual(cookieValues('a=1; kino_auth=abc; b=2', 'kino_auth'), ['abc']);
  assert.deepEqual(cookieValues('kino_auth=old;kino_auth=new', 'kino_auth'), ['old', 'new']);
  assert.deepEqual(cookieValues('xkino_auth=abc; kino_auth_x=1', 'kino_auth'), []);
  assert.deepEqual(cookieValues(undefined, 'kino_auth'), []);
  assert.deepEqual(cookieValues('kino_auth=a=b', 'kino_auth'), ['a=b']);
});

function clock(start = 1_000_000) { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Fail `n` times one second apart, then return the pause the last one started. */
const failBatch = (l: { fail(k: string): void; wait(k: string): number }, c: ReturnType<typeof clock>, key: string, n = 5) => {
  for (let i = 0; i < n; i++) { assert.equal(l.wait(key), 0, `try ${i} is allowed`); l.fail(key); if (i < n - 1) c.tick(1000); }
  return l.wait(key);
};

test('limiter: five wrong PINs, then a minute of waiting', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  for (let i = 0; i < 4; i++) { assert.equal(l.wait('a'), 0); l.fail('a'); c.tick(1000); }
  assert.equal(l.wait('a'), 0, 'the fifth try is still allowed');
  l.fail('a');
  assert.equal(l.wait('a'), MIN);
  c.tick(MIN - 1); assert.equal(l.wait('a'), 1);
  c.tick(1); assert.equal(l.wait('a'), 0);
  l.fail('a'); assert.equal(l.wait('a'), 0, 'the next five start counting after the pause');
});

test('limiter: going slowly gains nothing, the fifth failure pauses however late it comes', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  for (let i = 0; i < 4; i++) { l.fail('a'); assert.equal(l.wait('a'), 0, `try ${i}`); c.tick(10 * MIN); }
  l.fail('a');
  assert.equal(l.wait('a'), MIN);
});

test('limiter: each further five doubles the pause, up to an hour', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  const pauses: number[] = [];
  for (let i = 0; i < 9; i++) { const w = failBatch(l, c, 'a'); pauses.push(w / MIN); c.tick(w); }
  assert.deepEqual(pauses, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
});

test('limiter: a right PIN starts the ladder over', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  for (let i = 0; i < 3; i++) c.tick(failBatch(l, c, 'a'));
  l.fail('a'); l.fail('a');
  l.clear('a');
  assert.equal(l.size(), 0);
  assert.equal(failBatch(l, c, 'a'), MIN, 'a minute again, and the two failures before the right PIN are gone');
});

test('limiter: a day without a wrong PIN forgets the ladder, less than a day does not', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  c.tick(failBatch(l, c, 'a')); failBatch(l, c, 'a');   // 1, then 2 minutes
  c.tick(DAY - 1);
  assert.equal(failBatch(l, c, 'a'), 4 * MIN);
  c.tick(4 * MIN + DAY);
  assert.equal(failBatch(l, c, 'a'), MIN);
});

test('limiter: forgetting needs the pause to be over too', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now, blockMs: 2 * DAY, maxBlockMs: 2 * DAY });
  failBatch(l, c, 'a');
  c.tick(DAY + 1);
  for (let i = 0; i < 300; i++) l.fail(`k${i}`);   // sweeps
  assert.equal(l.wait('a'), DAY - 1, 'a day since its last failure, but still paused, so still remembered');
});

test('limiter: callers are counted apart, and a right PIN clears the count', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) l.fail('a');
  assert.ok(l.wait('a') > 0);
  assert.equal(l.wait('b'), 0);
  for (let i = 0; i < 4; i++) l.fail('b');
  l.clear('b'); l.fail('b');
  assert.equal(l.wait('b'), 0);
});

test('limiter: callers quiet for a day are swept, and the map never passes 4096', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  for (let i = 0; i < 300; i++) l.fail(`10.0.0.${i}`);
  assert.equal(l.size(), 300);
  c.tick(HOUR);
  l.fail('soon');
  assert.equal(l.size(), 301, 'an hour is not long enough to forget');
  c.tick(DAY);
  l.fail('late');
  assert.equal(l.size(), 1);
  for (let i = 0; i < 5000; i++) l.fail(`k${i}`);
  assert.equal(l.size(), 4096);
});

test('limiter: the sweep runs at most once a minute, and a caller it has not swept yet is forgotten all the same', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  for (let i = 0; i < 300; i++) for (let j = 0; j < 5; j++) l.fail(`10.0.0.${i}`);       // each paused for a minute
  c.tick(DAY - 30_000);
  l.fail('x');                                                                         // sweeps: none a day old yet
  assert.equal(l.size(), 301);
  c.tick(30_000);
  l.fail('y');                                                                         // all 300 a day old, but the last sweep was 30 s ago
  assert.equal(l.size(), 302);
  assert.equal(l.wait('10.0.0.0'), 0);
  assert.equal(l.pause('10.0.0.0'), 0);
  for (let j = 0; j < 4; j++) l.fail('10.0.0.0');
  assert.equal(l.wait('10.0.0.0'), 0, 'its ladder is gone: four wrong PINs do not pause it');
  l.fail('10.0.0.0');
  assert.equal(l.wait('10.0.0.0'), MIN, 'and the fifth pauses it for a minute, not two');
  c.tick(30_000);
  l.fail('z');                                                                         // a minute since the last sweep
  assert.equal(l.size(), 4, 'x, y, z and the one that failed again');
});

test('attemptKey: a LAN client is its own address, whatever X-Forwarded-For it sends', () => {
  assert.equal(attemptKey('192.168.1.20', '100.64.0.7'), '192.168.1.20');
  assert.equal(attemptKey('::ffff:192.168.1.20', '127.0.0.1'), '::ffff:192.168.1.20');
  assert.equal(attemptKey('fe80::1', '100.64.0.7'), 'fe80::1');
  assert.equal(attemptKey(undefined, '100.64.0.7'), '');
});

test('attemptKey: behind the loopback proxy, the visitor the proxy saw', () => {
  assert.equal(attemptKey('127.0.0.1', '100.64.0.7'), '100.64.0.7');
  assert.equal(attemptKey('::1', 'fd7a:115c:a1e0::7'), 'fd7a:115c:a1e0::7');
  assert.equal(attemptKey('::ffff:127.0.0.1', ' 100.64.0.7 '), '100.64.0.7');
  assert.equal(attemptKey('127.0.0.1', ['100.64.0.9']), '100.64.0.9');
});

test('attemptKey: addresses the visitor sent ahead of the one the proxy added are ignored', () => {
  assert.equal(attemptKey('127.0.0.1', '1.2.3.4, 100.64.0.7'), '100.64.0.7');
  assert.equal(attemptKey('127.0.0.1', ['1.2.3.4', '100.64.0.7']), '100.64.0.7');
});

test('attemptKey: loopback with no usable header stays loopback', () => {
  assert.equal(attemptKey('127.0.0.1', undefined), '127.0.0.1');
  assert.equal(attemptKey('127.0.0.1', ''), '127.0.0.1');
  assert.equal(attemptKey('::1', 'not an address'), '::1');
  assert.equal(attemptKey('127.0.0.1', '100.64.0.7:41641'), '127.0.0.1');
});

test('attemptKey + limiter: two tailnet visitors behind the proxy are paused apart', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  const a = attemptKey('127.0.0.1', '100.64.0.7'), b = attemptKey('127.0.0.1', '100.64.0.8');
  for (let i = 0; i < 5; i++) l.fail(a);
  assert.ok(l.wait(a) > 0);
  assert.equal(l.wait(b), 0, 'one visitor guessing does not lock out the other');
});

test('pinAttempts: a new key per try still stops at 30 wrong PINs a minute, for everyone', () => {
  const c = clock(); const l = pinAttempts({ now: c.now });
  for (let i = 0; i < 29; i++) { const k = attemptKey('127.0.0.1', `10.9.${i >> 8}.${i & 255}`); assert.equal(l.wait(k), 0, `try ${i}`); l.fail(k); c.tick(500); }
  assert.equal(l.wait('fresh'), 0, 'the 30th try is still allowed');
  l.fail('fresh');
  assert.ok(l.wait('fresh') > 0);
  assert.ok(l.wait('192.168.1.20') > 0, 'a caller that never failed waits too');
  l.clear('192.168.1.20');
  assert.ok(l.wait('192.168.1.20') > 0, 'a right PIN does not lift the total');
  c.tick(60_000);
  assert.equal(l.wait('192.168.1.20'), 0, 'a minute later logins work again');
});

test('pinAttempts: one caller still pauses alone after five', () => {
  const c = clock(); const l = pinAttempts({ now: c.now });
  for (let i = 0; i < 5; i++) l.fail('a');
  assert.ok(l.wait('a') > 0);
  assert.equal(l.wait('b'), 0);
});

test('pinAttempts: 29 a minute from fresh keys no longer slips under, the 30th pauses everyone', () => {
  const c = clock(); const l = pinAttempts({ now: c.now });
  for (let i = 0; i < 29; i++) { assert.equal(l.wait(`k${i}`), 0, `try ${i}`); l.fail(`k${i}`); c.tick(2100); }
  c.tick(MIN);
  l.fail('k29');
  assert.equal(l.wait('anyone'), MIN);
});

test('pinAttempts: a right PIN restarts that caller, the total ladder keeps climbing', () => {
  const c = clock(); const l = pinAttempts({ now: c.now });
  c.tick(failBatch(l, c, 'a')); c.tick(failBatch(l, c, 'a'));                   // a: 1, then 2 minutes
  l.clear('a');
  assert.equal(failBatch(l, c, 'a'), MIN, 'a starts at a minute again');
  c.tick(MIN);
  for (let i = 0; i < 15; i++) l.fail(`k${i}`);                                  // 30 in all: the total pauses for a minute
  assert.equal(l.wait('a'), MIN);
  c.tick(MIN); l.clear('a');
  for (let i = 0; i < 30; i++) { assert.equal(l.wait(`j${i}`), 0); l.fail(`j${i}`); }
  assert.equal(l.wait('a'), 2 * MIN, "a's right PIN did not reset everyone's ladder");
});

test('pinAttempts: a guesser with a new key per try gets 30 an hour once the pauses top out', () => {
  const c = clock(); const l = pinAttempts({ now: c.now });
  const start = c.now(); let tries = 0, firstHour = 0, half = 0;
  while (c.now() - start < 7 * DAY) {
    const k = `10.${tries >> 16}.${(tries >> 8) & 255}.${tries & 255}`, w = l.wait(k);
    if (w > 0) { c.tick(w); continue; }
    l.fail(k); tries++; c.tick(1000);
    if (c.now() - start <= HOUR) firstHour = tries;
    if (tries === 5000) half = c.now() - start;
  }
  assert.ok(firstHour <= 210, `first hour ${firstHour}`);
  assert.ok(tries <= 30 * 24 * 7 + 210, `a week: ${tries}`);
  assert.ok(half > 6 * DAY, `half of 4 digits (5000 tries) takes more than 6 days, not hours: ${(half / DAY).toFixed(1)} days`);
  assert.ok(l.size() <= 30 * 25, `remembered callers stay bounded: ${l.size()}`);
});

test('limiter: pause is the whole length of the pause in effect, not what is left', () => {
  const c = clock(); const l = attemptLimiter({ now: c.now });
  assert.equal(l.pause('a'), 0);
  failBatch(l, c, 'a');
  assert.equal(l.pause('a'), MIN);
  c.tick(MIN - 1); assert.equal(l.pause('a'), MIN); assert.equal(l.wait('a'), 1);
  c.tick(1); assert.equal(l.pause('a'), 0, 'over');
  failBatch(l, c, 'a');
  assert.equal(l.pause('a'), 2 * MIN);
});

test('pinAttempts: sharedPause reaches LONG_PAUSE_MS at the fifth shared pause (150 wrong PINs) and lasts as long as it does', () => {
  const c = clock(); const l = pinAttempts({ now: c.now });
  for (let i = 0; i < 5; i++) l.fail('a');
  assert.ok(l.pause('a') > 0);
  assert.equal(l.sharedPause(), 0, 'one caller paused alone is not a shared pause');
  const seen: number[] = []; let n = 0;
  for (let round = 0; round < 5; round++) {
    c.tick(l.wait('fresh'));
    for (let i = 0; i < 30; i++) { l.fail(`k${n++}`); c.tick(100); }
    seen.push(l.sharedPause() / MIN);
  }
  assert.deepEqual(seen, [1, 2, 4, 8, 16]);
  assert.ok(l.sharedPause() >= LONG_PAUSE_MS, 'the fifth pause is long');
  c.tick(15 * MIN);
  assert.ok(l.sharedPause() >= LONG_PAUSE_MS, 'still, a minute before it ends');
  c.tick(l.wait('fresh'));
  assert.equal(l.sharedPause(), 0, 'over once logins work again');
});

test('shortPin: under 6 characters', () => {
  for (const p of ['', '1', '1234', '12345']) assert.equal(shortPin(p), true, p);
  for (const p of ['123456', '12345678', 'correct horse']) assert.equal(shortPin(p), false, p);
});

test('pauseText: minutes rounded up, then hours', () => {
  assert.equal(pauseText(1), 'Too many wrong PINs. Try again in 1 minute.');
  assert.equal(pauseText(MIN), 'Too many wrong PINs. Try again in 1 minute.');
  assert.equal(pauseText(MIN + 1), 'Too many wrong PINs. Try again in 2 minutes.');
  assert.equal(pauseText(32 * MIN), 'Too many wrong PINs. Try again in 32 minutes.');
  assert.equal(pauseText(HOUR - 1), 'Too many wrong PINs. Try again in an hour.');
  assert.equal(pauseText(HOUR), 'Too many wrong PINs. Try again in an hour.');
  assert.equal(pauseText(3 * HOUR), 'Too many wrong PINs. Try again in 3 hours.');
});

test('pinOpen: what a TV, Chromecast or the lock screen reaches without the cookie', () => {
  const open: [string, string][] = [
    ['POST', '/api/auth'],
    ['GET', '/api/file/abc123/0'], ['HEAD', '/api/file/abc123/0'],
    ['GET', '/api/hls/s1/index.m3u8'], ['GET', '/api/hls/s1/seg-3.ts'], ['HEAD', '/api/hls/s1/index.m3u8'],
    ['GET', '/api/subs/file/x.vtt'], ['HEAD', '/api/subs/file/x.srt'],
    ['GET', '/api/cast/upnext/tok.vtt'],
  ];
  for (const [m, p] of open) assert.equal(pinOpen(m, p), true, `${m} ${p}`);
});

test('pinOpen: media is read only without the cookie, an HLS session cannot be sought, kept or stopped', () => {
  const locked: [string, string][] = [
    ['POST', '/api/hls/s1/seek'], ['POST', '/api/hls/s1/ping'], ['DELETE', '/api/hls/s1'], ['delete', '/api/hls/s1'], ['PUT', '/api/hls/s1/index.m3u8'],
    ['POST', '/api/file/abc123/0'], ['PUT', '/api/file/abc123/0'], ['DELETE', '/api/file/abc123/0'], ['OPTIONS', '/api/file/abc123/0'], ['PATCH', '/api/file/abc123/0'],
    ['POST', '/api/subs/file/x.vtt'], ['DELETE', '/api/subs/file/x.vtt'], ['POST', '/api/cast/upnext/tok.vtt'],
    ['GET', '/api/auth'], ['DELETE', '/api/auth'],
  ];
  for (const [m, p] of locked) assert.equal(pinOpen(m, p), false, `${m} ${p}`);
});

test('pinOpen: the library and settings stay locked', () => {
  const locked: [string, string][] = [
    ['GET', '/api/backup'], ['POST', '/api/settings'], ['GET', '/api/library'], ['GET', '/api/auth/x'],
    ['POST', '/api/cast/upnext'], ['GET', `/api/FILE/abc/0`],
  ];
  for (const [m, p] of locked) assert.equal(pinOpen(m, p), false, `${m} ${p}`);
});
