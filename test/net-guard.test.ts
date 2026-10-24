import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { privateAddress, localName, onLan, checkLan, guardedGet, io, REFUSED, NO_ANSWER, type GuardOpts } from '../server/net-guard.ts';

test('privateAddress: loopback, LAN, tailnet, link-local and reserved in IPv4 and IPv6, also inside IPv6 forms', () => {
  const priv = ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.144', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.251', '255.255.255.255', '198.18.0.1',
    '::1', '::', '[::1]', 'fe80::1', 'fe80::1%en0', 'fd7a:115c:a1e0::1', 'fc00::1', 'ff02::fb',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '::127.0.0.1', '2002:c0a8:101::1', '2002:7f00:1::',
    'localhost', 'not an address', ''];
  const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1'];
  for (const ip of priv) assert.equal(privateAddress(ip), true, ip);
  for (const ip of pub) assert.equal(privateAddress(ip), false, ip);
});

/** Run fn with names answering from `dns`, and the real address rule. */
async function withDns(dns: Record<string, string[]>, fn: () => Promise<void>): Promise<void> {
  const { lookup } = io;
  io.lookup = async (h) => {
    const all = dns[h];
    if (!all) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND' });
    return all.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  try { await fn(); } finally { io.lookup = lookup; }
}

test('checkLan by address: every address private; a literal is not looked up; a failed lookup is no', async () => {
  await withDns({ 'lan.test': ['192.168.1.2', 'fd00::2'], 'two.test': ['192.168.1.2', '8.8.8.8'], 'pub.test': ['8.8.8.8'] }, async () => {
    const lan = async (u: string) => (await checkLan(u)).lan;
    assert.equal(await lan('http://lan.test:7000/manifest.json'), true);
    assert.equal(await lan('http://two.test/x'), false, 'one public address is enough to say no');
    assert.equal(await lan('https://pub.test/x'), false);
    assert.equal(await lan('http://10.0.0.5:8080/x'), true);
    assert.equal(await lan('http://[::1]:8080/x'), true);
    assert.equal(await lan('http://1.1.1.1/x'), false);
    assert.equal(await lan('http://gone.test/x'), false);
  });
});

test('localName: names no public registry hands out', () => {
  for (const h of ['localhost', 'nas', 'NAS.local', 'nas.local.', 'pi.home.arpa', 'box.internal', 'router.lan', 'a.b.localhost']) assert.equal(localName(h), true, h);
  for (const h of ['example.org', 'local.example.org', 'lan.example.com', 'opensubtitles-v3.strem.io', '127.0.0.1', '[::1]', '::1', '', 'x.test']) assert.equal(localName(h), false, h);
});

test('onLan: an owner address is on the LAN by local name or by every address; a failed lookup or a bad URL is not', async () => {
  await withDns({ 'nas.local': ['192.168.1.2', '2a01:4f8::2'], 'mixed.test': ['192.168.1.2', '2a01:4f8::2'], 'lan.test': ['10.1.1.1'], 'pub.test': ['8.8.8.8'] }, async () => {
    assert.equal(await onLan('http://nas.local:7000/manifest.json'), true, 'a NAS on .local with a global IPv6 too');
    assert.equal(await onLan('http://mixed.test:7000/manifest.json'), false, 'the same answers under a public name');
    assert.equal(await onLan('http://lan.test/manifest.json'), true);
    assert.equal(await onLan('http://192.168.1.10:7000/manifest.json'), true);
    assert.equal(await onLan('https://pub.test/manifest.json'), false);
    assert.equal(await onLan('http://gone.test/manifest.json'), false);
    assert.equal(await onLan('not a url'), false);
  });
});

test('checkLan: the answers that made a name LAN ride along, none for a local-only name or a public host', async () => {
  await withDns({ 'nas.local': ['192.168.1.2', '2a01:4f8::2'], 'lan.test': ['10.1.1.1', 'fd00::1'], 'pub.test': ['8.8.8.8'] }, async () => {
    assert.deepEqual(await checkLan('http://nas.local:7000/manifest.json'), { host: 'nas.local', lan: true });
    assert.deepEqual(await checkLan('http://lan.test/manifest.json'), { host: 'lan.test', lan: true, addresses: [{ address: '10.1.1.1', family: 4 }, { address: 'fd00::1', family: 6 }] });
    assert.deepEqual(await checkLan('http://192.168.1.10:7000/manifest.json'), { host: '192.168.1.10', lan: true, addresses: [{ address: '192.168.1.10', family: 4 }] });
    assert.deepEqual(await checkLan('https://pub.test/manifest.json'), { host: 'pub.test', lan: false });
    assert.deepEqual(await checkLan('http://gone.test/manifest.json'), { host: 'gone.test', lan: false });
    assert.deepEqual(await checkLan('not a url'), { host: '', lan: false });
  });
});

// DNS rebinding: a name that answers one address for the check and another for the connection.
/** A box at 127.0.0.1 that says which Host it was asked for. Nothing answers on its port at ::1. */
const box = http.createServer((req, res) => res.end(`box ${req.headers.host}`));
await new Promise<void>((r) => box.listen(0, '127.0.0.1', r));
const PORT = (box.address() as AddressInfo).port;
after(() => { box.closeAllConnections(); box.close(); });

/**
 * Run fn with every name answering `first` once and `then` after that, `internet` counting as a public address, and
 * a count of lookups. Each test asks for its own names: the keep-alive pools would hand a later one a socket already open.
 */
async function rebinding(first: string, then: string, internet: string, fn: (lookups: () => number) => Promise<void>): Promise<void> {
  const { lookup, isPrivate } = io;
  let n = 0;
  io.lookup = async () => { const address = n++ === 0 ? first : then; return [{ address, family: address.includes(':') ? 6 : 4 }]; };
  io.isPrivate = (ip) => ip !== internet && privateAddress(ip);
  try { await fn(() => n); } finally { Object.assign(io, { lookup, isPrivate }); }
}
async function read(url: string, allowPrivate: GuardOpts['allowPrivate']): Promise<string> {
  const r = await guardedGet(url, { allowPrivate, what: 'addon', signal: AbortSignal.timeout(3000) });
  let s = ''; for await (const c of r.body) s += c;
  return s;
}

test('own-lan: a name the check found on the LAN is connected to at the address it saw, not where DNS points next', async () => {
  await rebinding('127.0.0.1', '::1', '::1', async (lookups) => {
    assert.equal(await read(`http://nas.test:${PORT}/manifest.json`, 'own-lan'), `box nas.test:${PORT}`, 'the box, asked by name');
    assert.equal(lookups(), 1, 'DNS asked once, for the check');
  });
});

test('a LanCheck made up front: the GET connects where it looked, whatever DNS says by then; another host gets no LAN', async () => {
  await rebinding('127.0.0.1', '::1', '::1', async (lookups) => {
    const check = await checkLan(`http://tuner.test:${PORT}/manifest.json`);
    assert.deepEqual(check, { host: 'tuner.test', lan: true, addresses: [{ address: '127.0.0.1', family: 4 }] });
    assert.equal(await read(`http://tuner.test:${PORT}/stream/tv/x.json`, check), `box tuner.test:${PORT}`);
    assert.equal(lookups(), 1);
    await assert.rejects(read(`http://127.0.0.1:${PORT}/x`, check), { code: REFUSED }, 'a check speaks for its own host only');
    await assert.rejects(read(`http://127.0.0.1:${PORT}/x`, { host: '127.0.0.1', lan: false }), { code: REFUSED }, 'and a no opens nothing');
  });
});

test('guarded: the address checked is the address connected to, from a single lookup', async () => {
  await rebinding('127.0.0.1', '10.9.9.9', '127.0.0.1', async (lookups) => {
    assert.equal(await read(`http://cdn.test:${PORT}/seg.ts`, false), `box cdn.test:${PORT}`);
    assert.equal(lookups(), 1);
  });
  await rebinding('10.9.9.9', '127.0.0.1', '127.0.0.1', async (lookups) => {
    await assert.rejects(read(`http://cdn2.test:${PORT}/seg.ts`, false), { code: REFUSED });
    assert.equal(lookups(), 1, 'refused on the answer it checked, never asked again');
  });
});

test('pinned https: the TLS server name is still the host name', async () => {
  let sni = '';
  const t = tls.createServer({ SNICallback: (name, cb) => { sni = name; cb(new Error('no certificate here')); } });
  await new Promise<void>((r) => t.listen(0, '127.0.0.1', r));
  try {
    await rebinding('127.0.0.1', '::1', '::1', async (lookups) => {
      await assert.rejects(read(`https://tv.test:${(t.address() as AddressInfo).port}/x`, 'own-lan'), { code: NO_ANSWER, status: 502 });
      assert.equal(sni, 'tv.test');
      assert.equal(lookups(), 1);
    });
  } finally { t.close(); }
});
