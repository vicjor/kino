import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { hostAllowed, hostName, envHosts, hostGuard, plainRedirect } from '../server/host.ts';

const TS = 'mac.example.ts.net';   // stand-in for the tailnet name, never the real one

test('hostName: lowercase, port, trailing dot and IPv6 brackets off', () => {
  assert.equal(hostName('Kino.Local:1234'), 'kino.local');
  assert.equal(hostName('kino.local.'), 'kino.local');
  assert.equal(hostName('192.168.1.144:1234'), '192.168.1.144');
  assert.equal(hostName('[fe80::1]:1234'), 'fe80::1');
  assert.equal(hostName('[::1]'), '::1');
  assert.equal(hostName('kino.local:abc'), '');
  assert.equal(hostName('[evil.example]:1234'), '');
});

test('a TV or phone by IP passes, v4 and v6, with or without port', () => {
  for (const h of ['192.168.1.144:1234', '192.168.1.144', '127.0.0.1:1234', '[fe80::1c2b:3aff:fe4d:5e6f]:1234', '[::1]', '::1', '100.64.0.7:1234']) assert.equal(hostAllowed(h), true, h);
});

test('kino.local, any .local name, localhost', () => {
  for (const h of ['kino.local', 'kino.local:1234', 'KINO.LOCAL:1234', 'kino.local.:1234', 'macbook-pro.local', 'localhost', 'localhost:1299']) assert.equal(hostAllowed(h), true, h);
});

test('tailscale serve: the tailnet name, with or without :443', () => {
  assert.equal(hostAllowed(TS), true);
  assert.equal(hostAllowed(`${TS}:443`), true);
});

test('vite dev proxy: changeOrigin sends the API host, localhost:<api port>', () => {
  assert.equal(hostAllowed('localhost:1234'), true);
  assert.equal(hostAllowed('localhost:1299'), true);   // dev:iso
});

test("this Mac's own name, bare and .local", () => {
  const me = os.hostname(), short = me.split('.')[0]!;
  assert.equal(hostAllowed(me), true);
  assert.equal(hostAllowed(`${short}:1234`), true);
  assert.equal(hostAllowed(`${short.toUpperCase()}.local`), true);
});

test('DNS rebinding names are refused', () => {
  for (const h of ['evil.example', 'evil.example:1234', 'rebind.evil.example:1234', '192.168.1.144.nip.io:1234', 'localhost.evil.example', 'kino.local.evil.example', 'ts.net.evil.example', 'local', 'evil.example:1234:1']) assert.equal(hostAllowed(h), false, h);
});

test('a Host with more than a name in it is refused, whatever it ends in', () => {
  for (const h of ['evil.example/x.local', 'evil.example?.local', 'evil.example#.local', 'a@evil.example.local', 'evil.example\\.local', 'evil.example .local', `evil.example/${TS}`, 'evil.example%2f.local']) {
    assert.equal(hostName(h), '', h);
    assert.equal(hostAllowed(h), false, h);
  }
});

test('plainRedirect: same name on the Kino port, path kept', () => {
  assert.equal(plainRedirect('kino.local', '/#/title/tt1', 1234, '192.168.1.144'), 'http://kino.local:1234/#/title/tt1');
  assert.equal(plainRedirect('Kino.Local:80', '/x?y=1', 1234, '192.168.1.144'), 'http://kino.local:1234/x?y=1');
  assert.equal(plainRedirect('192.168.1.144', '/', 1234, '10.0.0.1'), 'http://192.168.1.144:1234/');
  assert.equal(plainRedirect('[fe80::1]:80', '/', 1234, '10.0.0.1'), 'http://[fe80::1]:1234/');
  assert.equal(plainRedirect('::1', '/', 1234, '10.0.0.1'), 'http://[::1]:1234/');
  assert.equal(plainRedirect('kino.home.arpa', '/', 1234, '10.0.0.1', ['kino.home.arpa']), 'http://kino.home.arpa:1234/');
});

test('plainRedirect: no Host goes to the LAN address', () => {
  assert.equal(plainRedirect(undefined, '/a', 1234, '192.168.1.144'), 'http://192.168.1.144:1234/a');
  assert.equal(plainRedirect('  ', undefined, 1234, '192.168.1.144'), 'http://192.168.1.144:1234/');
});

test('plainRedirect: a Host Kino does not answer to gets null (421), never a Location elsewhere', () => {
  for (const h of ['evil.example', 'evil.example:80', 'evil.example/x.local', 'a@evil.example.local', 'kino.home.arpa']) assert.equal(plainRedirect(h, '/', 1234, '10.0.0.1'), null, h);
});

test('plainRedirect: only a plain path is kept', () => {
  assert.equal(plainRedirect('kino.local', 'http://evil.example/', 1234, '10.0.0.1'), 'http://kino.local:1234/');
  assert.equal(plainRedirect('kino.local', '*', 1234, '10.0.0.1'), 'http://kino.local:1234/');
  assert.equal(plainRedirect('kino.local', '/café', 1234, '10.0.0.1'), 'http://kino.local:1234/');
  assert.equal(plainRedirect('kino.local', '/a b', 1234, '10.0.0.1'), 'http://kino.local:1234/');
  assert.equal(plainRedirect('kino.local', '//evil.example/x', 1234, '10.0.0.1'), 'http://kino.local:1234//evil.example/x', 'after the authority: a path on Kino, not another host');
});

test('no Host header: an HTTP/1.0 client, never a browser', () => {
  assert.equal(hostAllowed(undefined), true);
  assert.equal(hostAllowed(''), true);
});

test('KINO_HOSTS: exact names, and a leading dot for every name under it', () => {
  const extra = envHosts(' Kino.Home.Arpa , .example.org,,');
  assert.deepEqual(extra, ['kino.home.arpa', '.example.org']);
  assert.equal(hostAllowed('kino.home.arpa:1234', extra), true);
  assert.equal(hostAllowed('other.home.arpa', extra), false);
  assert.equal(hostAllowed('example.org', extra), true);
  assert.equal(hostAllowed('tv.example.org', extra), true);
  assert.equal(hostAllowed('badexample.org', extra), false);
  assert.deepEqual(envHosts(''), []);
  assert.deepEqual(envHosts(undefined), []);
});

test('hostGuard: 421 with a JSON error, next() for a known host', () => {
  const guard = hostGuard([], () => 0);
  const call = (host: string) => {
    let status = 0, body: unknown, passed = false;
    const res = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
    guard({ headers: { host }, path: '/api/backup', socket: { remoteAddress: '192.168.1.20' } } as never, res as never, () => { passed = true; });
    return { status, body, passed };
  };
  assert.deepEqual(call('192.168.1.144:1234'), { status: 0, body: undefined, passed: true });
  const r = call('evil.example:1234');
  assert.equal(r.status, 421);
  assert.equal(r.passed, false);
  assert.match((r.body as { error: string }).error, /host/i);
});
