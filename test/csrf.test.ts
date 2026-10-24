import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCrossSiteWrite } from '../server/csrf.ts';

const LAN = '192.168.1.144:1234';
const TS = 'mac.example.ts.net';   // stand-in for the tailnet name, never the real one

test('reads never count, whoever sends them', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) {
    assert.equal(isCrossSiteWrite(m, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: LAN }), false, m);
  }
});

test('Sec-Fetch-Site cross-site is refused for every write method', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'post']) {
    assert.equal(isCrossSiteWrite(m, { 'sec-fetch-site': 'cross-site', host: LAN }), true, m);
    assert.equal(isCrossSiteWrite(m, { 'sec-fetch-site': 'Cross-Site', origin: 'https://evil.example', host: LAN }), true, m);
  }
});

test('same-origin and typed-in requests pass, even with a stray Origin', () => {
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': 'same-origin', origin: `http://${LAN}`, host: LAN }), false);
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': 'same-origin', host: LAN }), false);
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': 'none', host: LAN }), false);
});

test('no Origin and no Sec-Fetch-Site: curl, Home Assistant, iOS Shortcuts pass', () => {
  assert.equal(isCrossSiteWrite('POST', { host: LAN }), false);
  assert.equal(isCrossSiteWrite('POST', { host: LAN, 'user-agent': 'HomeAssistant/2026.9 aiohttp/3.9' }), false);
  assert.equal(isCrossSiteWrite('DELETE', {}), false);
});

test('older browser without Sec-Fetch-Site: Origin must match Host', () => {
  assert.equal(isCrossSiteWrite('POST', { origin: `http://${LAN}`, host: LAN }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: 'http://Kino.Local:1234', host: 'kino.local:1234' }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: 'https://evil.example', host: LAN }), true);
  assert.equal(isCrossSiteWrite('POST', { origin: 'http://192.168.1.144:8123', host: LAN }), true, 'another port is another origin');
  assert.equal(isCrossSiteWrite('POST', { origin: 'http://192.168.1.1', host: LAN }), true);
  assert.equal(isCrossSiteWrite('POST', { origin: `http://${LAN}` }), true, 'no Host to match');
});

test('default ports compare equal', () => {
  assert.equal(isCrossSiteWrite('POST', { origin: 'http://kino.local', host: 'kino.local:80' }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: 'http://kino.local:80', host: 'kino.local' }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: `https://${TS}`, host: `${TS}:443` }), false);
});

test('an opaque Origin ("null", file) is refused', () => {
  assert.equal(isCrossSiteWrite('POST', { origin: 'null', host: LAN }), true);
  assert.equal(isCrossSiteWrite('POST', { origin: 'file://', host: LAN }), true);
  assert.equal(isCrossSiteWrite('POST', { origin: 'not a url', host: LAN }), true);
});

test('same-site (another port on this Mac) falls back to the Origin check', () => {
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': 'same-site', origin: 'http://192.168.1.144:8123', host: LAN }), true);
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': 'same-site', origin: `http://${LAN}`, host: LAN }), false);
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': 'same-site', host: LAN }), false);
});

test('vite dev proxy (changeOrigin + xfwd): Host is :1234, the page host rides in X-Forwarded-Host', () => {
  assert.equal(isCrossSiteWrite('PUT', { 'sec-fetch-site': 'same-origin', origin: 'http://kino.local:5173', host: 'localhost:1234' }), false);
  assert.equal(isCrossSiteWrite('PUT', { origin: 'http://localhost:5173', host: 'localhost:1234', 'x-forwarded-host': 'localhost:5173' }), false);
  assert.equal(isCrossSiteWrite('PUT', { origin: 'http://evil.example', host: 'localhost:1234', 'x-forwarded-host': 'localhost:5173' }), true);
});

test('tailscale serve: Origin matches X-Forwarded-Host while Host is the loopback target', () => {
  assert.equal(isCrossSiteWrite('POST', { origin: `https://${TS}`, host: '127.0.0.1:1234', 'x-forwarded-host': TS }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: `https://${TS}`, host: '127.0.0.1:1234', 'x-forwarded-host': `other.example, ${TS}` }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: 'https://evil.example.ts.net', host: '127.0.0.1:1234', 'x-forwarded-host': TS }), true);
});

test('array-valued headers use the first value', () => {
  assert.equal(isCrossSiteWrite('POST', { 'sec-fetch-site': ['cross-site'] as unknown as string, host: LAN }), true);
});
