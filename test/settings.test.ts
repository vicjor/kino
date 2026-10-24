import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sanitizeSettings, mergeBackup, isBackup, addonUrl, MAX_MIN_FREE_BYTES } from '../server/settings.ts';
import { encodeSubId, decodeSubId, payloadOf } from '../server/subs/ids.ts';
import type { State } from '../server/store.ts';
import type { Progress } from '../server/types.ts';

const GB = 1024 ** 3;
const clean = (b: unknown) => sanitizeSettings(b);
const ok = (b: Record<string, unknown>) => { const r = clean(b); assert.deepEqual(r.errors, [], JSON.stringify(b)); return r.settings; };
const refused = (b: Record<string, unknown>, re?: RegExp) => {
  const r = clean(b);
  assert.equal(r.errors.length, 1, JSON.stringify(b));
  if (re) assert.match(r.errors[0], re);
  for (const k of Object.keys(b)) if (k !== 'addons') assert.equal(k in r.settings, false, `${k} left out`);
};

test('addons: http(s) manifest.json links only, stremio:// read as https, duplicates once', () => {
  assert.deepEqual(ok({ addons: ['https://a.example/manifest.json', ' stremio://b.example/x/manifest.json ', 'https://a.example/manifest.json'] }).addons, ['https://a.example/manifest.json', 'https://b.example/x/manifest.json']);
  assert.deepEqual(ok({ addons: [] }).addons, []);
  for (const bad of ['https://a.example/', 'ftp://a.example/manifest.json', 'javascript:alert(1)//manifest.json', 'manifest.json', 'http://', 42, null]) {
    const r = clean({ addons: ['https://a.example/manifest.json', bad] });
    assert.match(r.errors.join(), /manifest\.json/, String(bad));
    assert.deepEqual(r.settings.addons, ['https://a.example/manifest.json'], 'the good ones survive for a restore');
  }
  refused({ addons: 'https://a.example/manifest.json' }, /manifest/);
  assert.equal(addonUrl('http://h:7000/path/manifest.json?key=1'), 'http://h:7000/path/manifest.json?key=1');
});

test('webhook: an http(s) URL, trimmed; empty or null clears it; anything else is refused', () => {
  assert.equal(ok({ haWebhookUrl: ' http://homeassistant.local:8123/api/webhook/kino ' }).haWebhookUrl, 'http://homeassistant.local:8123/api/webhook/kino');
  assert.equal(ok({ haWebhookUrl: 'https://ha.example/api/webhook/x' }).haWebhookUrl, 'https://ha.example/api/webhook/x');
  for (const v of ['', null]) { const s = ok({ haWebhookUrl: v }); assert.ok('haWebhookUrl' in s && s.haWebhookUrl === undefined, String(v)); }
  for (const v of ['homeassistant.local:8123/api/webhook/kino', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', 'not a url', 42, true, ['http://x']]) refused({ haWebhookUrl: v }, /webhook/);
});

test('cache limit at least 1 GB, free space 0 to 100 GB, both finite numbers', () => {
  assert.equal(ok({ cacheCapBytes: GB }).cacheCapBytes, GB);
  assert.equal(ok({ cacheCapBytes: 500 * GB }).cacheCapBytes, 500 * GB);
  for (const v of [0, GB - 1, -1, '10737418240', Infinity, NaN, null]) refused({ cacheCapBytes: v }, /cache/);
  assert.equal(ok({ minFreeBytes: 0 }).minFreeBytes, 0);
  assert.equal(ok({ minFreeBytes: MAX_MIN_FREE_BYTES }).minFreeBytes, 100 * GB);
  for (const v of [-1, MAX_MIN_FREE_BYTES + 1, 1e15, '3', NaN]) refused({ minFreeBytes: v }, /free/);
});

test('subtitle size and countdown are clamped, as before; not a number is refused', () => {
  assert.equal(ok({ subFontSize: 10 }).subFontSize, 50);
  assert.equal(ok({ subFontSize: 900 }).subFontSize, 250);
  assert.equal(ok({ subFontSize: 120 }).subFontSize, 120);
  assert.equal(ok({ autoNextDelaySec: -3 }).autoNextDelaySec, 0);
  assert.equal(ok({ autoNextDelaySec: 600 }).autoNextDelaySec, 60);
  refused({ subFontSize: '120' }); refused({ autoNextDelaySec: Infinity });
});

test('API keys trimmed, empty or null clears; switches must be true or false', () => {
  assert.equal(ok({ tmdbApiKey: ' abc ' }).tmdbApiKey, 'abc');
  for (const v of ['', '   ', null]) { const s = ok({ omdbApiKey: v }); assert.ok('omdbApiKey' in s && s.omdbApiKey === undefined); }
  refused({ tmdbApiKey: 123 });
  assert.deepEqual(ok({ autoSubs: false, autoNext: true, onboarded: true }), { autoSubs: false, autoNext: true, onboarded: true });
  for (const k of ['autoSubs', 'autoNext', 'onboarded']) refused({ [k]: 'true' });
});

test('languages lower-cased once each; non-text items dropped', () => {
  assert.deepEqual(ok({ subLangs: ['ENG', 'nor', 'eng', '', 3, null] }).subLangs, ['eng', 'nor']);
  refused({ subLangs: 'eng' });
});

test('unknown keys are dropped, undefined is absent, and a non-object is refused', () => {
  assert.deepEqual(ok({ nope: 1, __proto__: { autoNext: false }, autoNext: undefined }), {});
  for (const v of [null, undefined, 'x', 3, []]) assert.equal(clean(v).errors.length, 1);
  assert.deepEqual(ok({}), {});
});

// ------------------------------------------------------------------ backup --
const base = (): State => ({
  settings: { addons: ['https://mine.example/manifest.json'], subLangs: ['eng'], cacheCapBytes: 10 * GB, minFreeBytes: 3 * GB, subFontSize: 100, autoNext: true, autoNextDelaySec: 10, onboarded: true, haWebhookUrl: 'http://ha.local/api/webhook/k' },
  progress: {}, watchlist: [], following: [], cacheIndex: {}, castHistory: {}, downloads: {}, credits: {}, intros: {}, v: 2,
});
const prog = (videoId: string, updatedAt: number, pos = 100): Progress => ({ videoId, metaId: videoId.split(':')[0], type: 'movie', pos, dur: 1000, updatedAt, name: videoId });

test('restore: settings go through the sanitizer, addons are added to yours', () => {
  const s = mergeBackup(base(), { settings: { cacheCapBytes: 0, minFreeBytes: 1e15, subFontSize: 'big', haWebhookUrl: 'javascript:alert(1)', addons: ['https://theirs.example/manifest.json', 'evil', 'https://mine.example/manifest.json'], autoNext: false, weird: 1 } });
  assert.equal(s.settings.cacheCapBytes, 10 * GB, 'a 0 cache limit would evict everything');
  assert.equal(s.settings.minFreeBytes, 3 * GB, 'a huge one would refuse every play');
  assert.equal(s.settings.subFontSize, 100);
  assert.equal(s.settings.haWebhookUrl, 'http://ha.local/api/webhook/k');
  assert.deepEqual(s.settings.addons, ['https://mine.example/manifest.json', 'https://theirs.example/manifest.json']);
  assert.equal(s.settings.autoNext, false, 'valid fields still restore');
  assert.equal('weird' in s.settings, false);
});

test('restore: newer progress wins, broken or prototype entries are skipped', () => {
  const s = base();
  s.progress.tt1 = prog('tt1', 5); s.progress.tt2 = prog('tt2', 9);
  const progress = JSON.parse(`{"tt1":${JSON.stringify(prog('tt1', 7, 300))},"tt2":${JSON.stringify(prog('tt2', 8, 50))},"tt3":${JSON.stringify(prog('tt3', 1))},"__proto__":${JSON.stringify(prog('x', 1))},"tt4":{"pos":"a"},"tt5":null,"tt6":${JSON.stringify({ ...prog('tt6', 1), metaId: 'constructor' })}}`);
  mergeBackup(s, { progress });
  assert.deepEqual(Object.keys(s.progress).sort(), ['tt1', 'tt2', 'tt3']);
  assert.equal(s.progress.tt1.pos, 300, 'backup newer');
  assert.equal(s.progress.tt2.pos, 100, 'mine newer');
  assert.equal(Object.getPrototypeOf(s.progress), Object.prototype);
});

test('restore: lists add what is missing; cast history merges without duplicates, newest first', () => {
  const s = base();
  s.watchlist.push({ id: 'tt1', type: 'movie', name: 'A', addedAt: 1 });
  s.castHistory.tv = [{ ts: 300, app: 'Kino', title: 'C' }, { ts: 100, app: 'Kino', title: 'A' }];
  const b = { watchlist: [{ id: 'tt1', type: 'movie', name: 'A', addedAt: 1 }, { id: 'tt2', type: 'series', name: 'B', addedAt: 2 }, { nope: 1 }, { id: '__proto__' }], following: [{ id: 'tt9', name: 'S', addedAt: 3 }], castHistory: { tv: [{ ts: 200, app: 'Kino', title: 'B' }, { ts: 100, app: 'Kino', title: 'A' }, { ts: 'x' }], speaker: [{ ts: 50, app: 'Music', title: 'Song' }] } };
  mergeBackup(s, b);
  assert.deepEqual(s.watchlist.map((w) => w.id), ['tt1', 'tt2']);
  assert.deepEqual(s.following.map((f) => f.id), ['tt9']);
  assert.deepEqual(s.castHistory.tv.map((e) => e.title), ['C', 'B', 'A']);
  assert.deepEqual(s.castHistory.speaker.map((e) => e.title), ['Song']);
  const big = { castHistory: { tv: Array.from({ length: 80 }, (_, i) => ({ ts: 1000 + i, app: 'Kino', title: `T${i}` })) } };
  mergeBackup(s, big);
  assert.equal(s.castHistory.tv.length, 50);
  assert.equal(s.castHistory.tv[0].title, 'T79');
});

test('restore: learned credits and intro points fill in what this install has not learned', () => {
  const s = base();
  s.credits.tt1 = [40]; s.intros.tt1 = [{ start: 60, end: 150 }];
  mergeBackup(s, { credits: { tt1: [90], tt2: [30, 'x', 35, 31, 32, 33, 34] }, intros: { tt1: [{ start: 1, end: 90 }], tt2: [{ start: 30, end: 120 }, { start: 'a' }], __proto__: [] } });
  assert.deepEqual(s.credits, { tt1: [40], tt2: [35, 31, 32, 33, 34] });
  assert.deepEqual(s.intros, { tt1: [{ start: 60, end: 150 }], tt2: [{ start: 30, end: 120 }] });
});

test('restore: subtitle picks from another install are signed with this one; garbage goes, the language stays', () => {
  const mine = crypto.randomBytes(32), theirs = crypto.randomBytes(32);
  const os = { o: 'os' as const, u: 'https://example.org/s.srt' }, tor = { o: 't' as const, h: 'abc', i: 1 };
  const foreign = encodeSubId(os, theirs), own = encodeSubId(tor, mine), legacy = payloadOf(encodeSubId(tor, theirs));
  const sub = (id: string, subId: unknown) => ({ ...prog(id, 5), subId, subLang: 'nor' });
  const bad = ['garbage', `${legacy}.short`, `${foreign}.x`, 42, `${Buffer.from(JSON.stringify({ o: 'zz' })).toString('base64url')}.${'A'.repeat(22)}`];
  const b = { progress: {
    tt1: sub('tt1', foreign), tt2: sub('tt2', own), tt3: sub('tt3', legacy), tt4: { ...prog('tt4', 5), subId: null }, tt5: prog('tt5', 5),
    ...Object.fromEntries(bad.map((v, i) => [`bad${i}`, sub(`bad${i}`, v)])),
  } };
  const s = mergeBackup(base(), structuredClone(b), mine);
  const p = s.progress;
  assert.deepEqual(decodeSubId(p.tt1.subId!, mine), os, 'signed on another Mac: re-signed here');
  assert.equal(payloadOf(p.tt1.subId!), payloadOf(foreign), 'same payload, same cached subtitle file');
  assert.equal(p.tt2.subId, own, 'signed here: kept as it is');
  assert.equal(p.tt3.subId, own, 'from before signing: signed here');
  assert.equal(p.tt4.subId, null, 'turned off stays off');
  assert.equal('subId' in p.tt5, false, 'nothing chosen stays unset');
  bad.forEach((v, i) => {
    const e = p[`bad${i}`];
    assert.equal('subId' in e, false, `${v}: dropped, not null (null is subtitles off)`);
    assert.equal(e.subLang, 'nor', `${v}: the language stays`);
  });
  const snap = structuredClone(s);
  assert.deepEqual(mergeBackup(s, structuredClone(b), mine), snap, 'restoring it again changes nothing');
});

test('restore: the same backup twice changes nothing the second time', () => {
  const b = { settings: { addons: ['https://theirs.example/manifest.json'] }, progress: { tt1: prog('tt1', 3) }, watchlist: [{ id: 'tt2', type: 'movie', name: 'B', addedAt: 1 }], castHistory: { tv: [{ ts: 1, app: 'Kino', title: 'A' }] }, credits: { tt1: [40] }, intros: { tt1: [{ start: 60, end: 150 }] } };
  const once = mergeBackup(base(), structuredClone(b));
  const snap = structuredClone(once);
  assert.deepEqual(mergeBackup(once, structuredClone(b)), snap);
});

test('isBackup: an object with progress, settings or a watchlist', () => {
  for (const b of [{ progress: {} }, { settings: {} }, { watchlist: [] }]) assert.equal(isBackup(b), true);
  for (const b of [null, undefined, [], 'x', {}, { following: [] }, { progress: null }]) assert.equal(isBackup(b), false, JSON.stringify(b));
});
