import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internal, discover, isAudioOnly, parseBrowse, parseLookup, parseResolve, type Run } from '../server/cast/dnssd.ts';

// Captured from `dns-sd` on macOS (ids and names anonymised). Columns are space-padded, not tabs.
const BROWSE = `Browsing for _googlecast._tcp.local.
DATE: ---Thu 01 Oct 2026---
 4:02:46.060  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
 4:02:46.060  Add        3  14 local.               _googlecast._tcp.    Google-Nest-Mini-0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a
 4:02:46.060  Add        3  14 local.               _googlecast._tcp.    Google-Cast-Group-1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B
 4:02:46.060  Add        3  14 local.               _googlecast._tcp.    Nest-Audio-2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c
 4:02:46.060  Add        2  14 local.               _googlecast._tcp.    Chromecast-3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d
 4:02:47.512  Add        2  14 local.               _googlecast._tcp.    Bedroom TV
 4:02:48.900  Rmv        0  14 local.               _googlecast._tcp.    Kitchen display
 4:02:49.001  Add        2  14 local.               _googlecast._tcp.    Chromecast-3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d
`;

const LOOKUP = `Lookup Chromecast-3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d._googlecast._tcp.local.
DATE: ---Thu 01 Oct 2026---
 4:02:54.135  ...STARTING...
 4:02:54.139  Chromecast-3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d._googlecast._tcp.local. can be reached at 3d3d3d3d-3d3d-3d3d-3d3d-3d3d3d3d3d3d.local.:8009 (interface 14)
 id=3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d cd=4E4E4E4E4E4E4E4E4E4E4E4E4E4E4E4E rm= ve=05 md=Chromecast ic=/setup/icon.png fn=Living\\ room\\ TV ca=201221 st=0 bs=FA8FCA000000 nf=1 rs=
`;

const LOOKUP_GROUP = `Lookup Google-Cast-Group-1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B._googlecast._tcp.local.
DATE: ---Thu 01 Oct 2026---
 4:02:54.139  ...STARTING...
 4:02:54.139  Google-Cast-Group-1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B._googlecast._tcp.local. can be reached at 0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a.local.:32169 (interface 14)
 id=1B1B1B1B-1B1B-1B1B-1B1B-1B1B1B1B1B1B cd=1B1B1B1B-1B1B-1B1B-1B1B-1B1B1B1B1B1B rm= ve=05 md=Google\\ Cast\\ Group ic=/setup/icon.png fn=All\\ speakers ca=198692 st=0 bs=FA8FCA111111 nf=1 rs=
`;

const RESOLVE = `DATE: ---Thu 01 Oct 2026---
 4:02:59.996  ...STARTING...
Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL
 4:02:59.998  Add  40000002       0  3d3d3d3d-3d3d-3d3d-3d3d-3d3d3d3d3d3d.local. 0.0.0.0                                      108   No Such Record
 4:02:59.999  Add  40000002      14  3d3d3d3d-3d3d-3d3d-3d3d-3d3d3d3d3d3d.local. 192.168.1.131                                120
`;

test('parseTxt handles escaped spaces and empty values', () => {
  const txt = _internal.parseTxt(' id=67527411dd97 md=Nest\\ Audio fn=Living\\ room\\ speaker rm= ca=199172');
  assert.equal(txt.id, '67527411dd97');
  assert.equal(txt.md, 'Nest Audio');
  assert.equal(txt.fn, 'Living room speaker');
  assert.equal(txt.ca, '199172');
  assert.equal(txt.rm, '');
});

test('parseBrowse: Add lines only, deduped, names with spaces kept whole, headers and Rmv ignored', () => {
  assert.deepEqual(parseBrowse(BROWSE), [
    'Google-Nest-Mini-0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a',
    'Google-Cast-Group-1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B',
    'Nest-Audio-2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c',
    'Chromecast-3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d',
    'Bedroom TV',
  ]);
  assert.deepEqual(parseBrowse(''), []);
});

test('parseLookup: host without the trailing dot, port, txt with escaped spaces', () => {
  const l = parseLookup(LOOKUP);
  assert.ok(l);
  assert.equal(l.host, '3d3d3d3d-3d3d-3d3d-3d3d-3d3d3d3d3d3d.local');
  assert.equal(l.port, 8009);
  assert.equal(l.txt.md, 'Chromecast');
  assert.equal(l.txt.fn, 'Living room TV');
  assert.equal(l.txt.id, '3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d');
  const g = parseLookup(LOOKUP_GROUP);
  assert.equal(g?.port, 32169);
  assert.equal(g?.txt.md, 'Google Cast Group');
  assert.equal(g?.txt.fn, 'All speakers');
});

test('parseLookup: undefined until a "can be reached" line arrives', () => {
  assert.equal(parseLookup(LOOKUP.split('\n').slice(0, 3).join('\n')), undefined);
  assert.equal(parseLookup(''), undefined);
});

test('parseResolve: skips the 0.0.0.0 "No Such Record" Add, takes the real address', () => {
  assert.equal(parseResolve(RESOLVE), '192.168.1.131');
  const negativeOnly = RESOLVE.split('\n').filter((l) => !l.includes('192.168.')).join('\n');
  assert.equal(parseResolve(negativeOnly), undefined);
  assert.equal(parseResolve(RESOLVE.replace(/Add(?=\s+40000002\s+14)/, 'Rmv')), undefined);
  assert.equal(parseResolve(''), undefined);
});

/** Fake dns-sd: browse sees a TV and a group, lookups and resolves answer from the fixtures. */
function fakeExec(calls: string[][], gate?: Promise<void>): Run {
  return async (args) => {
    calls.push(args);
    if (args[0] === '-B') { await gate; return BROWSE.split('\n').filter((l) => /Chromecast-|Cast-Group/.test(l) || !/Add|Rmv/.test(l)).join('\n'); }
    if (args[0] === '-L') return args[1].startsWith('Chromecast-') ? LOOKUP : LOOKUP_GROUP;
    if (args[0] === '-Gv4') return args[1].startsWith('3d3d') ? RESOLVE : RESOLVE.replace('192.168.1.131', '192.168.1.140');
    return '';
  };
}

test('discover: browse, lookup and resolve become CastDevices with the shared audio-only flag', async () => {
  const calls: string[][] = [];
  const out = await discover(4000, fakeExec(calls));
  assert.deepEqual(out.map((d) => [d.id, d.name, d.model, d.host, d.port, d.audioOnly]), [
    ['1B1B1B1B-1B1B-1B1B-1B1B-1B1B1B1B1B1B', 'All speakers', 'Google Cast Group', '192.168.1.140', 32169, true],
    ['3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d', 'Living room TV', 'Chromecast', '192.168.1.131', 8009, false],
  ]);
  assert.deepEqual(calls.map((c) => c[0]), ['-B', '-L', '-L', '-Gv4', '-Gv4']);
});

test('discover: overlapping calls share one pass, the next call starts a fresh one', async () => {
  const calls: string[][] = [];
  let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
  const exec = fakeExec(calls, gate);
  const a = discover(4000, exec); const b = discover(4000, exec);
  assert.equal(a, b);
  open();
  assert.equal((await a).length, 2);
  assert.equal(calls.filter((c) => c[0] === '-B').length, 1);
  await discover(4000, fakeExec(calls));
  assert.equal(calls.filter((c) => c[0] === '-B').length, 2);
});

test('discover: a failed pass does not wedge the guard', async () => {
  await assert.rejects(discover(4000, async () => { throw new Error('spawn failed'); }), /spawn failed/);
  assert.equal((await discover(4000, fakeExec([]))).length, 2);
});

test('audioOnly classification', () => {
  assert.equal(isAudioOnly('Chromecast'), false);
  assert.equal(isAudioOnly('Chromecast Ultra'), false);
  assert.equal(isAudioOnly('Nest Audio'), true);
  assert.equal(isAudioOnly('Google Nest Mini'), true);
  assert.equal(isAudioOnly('Google Home Mini'), true);
  assert.equal(isAudioOnly('Google Cast Group'), true);
  assert.equal(isAudioOnly('Google Nest Hub'), true);
  assert.equal(isAudioOnly('Unknown'), false);
});

test('audioOnly: a bare "audio" model is a speaker on both discovery paths (was bonjour only)', () => {
  assert.equal(isAudioOnly('Acme Smart Audio'), true);
  assert.equal(isAudioOnly('Chromecast Audio'), false);
});
