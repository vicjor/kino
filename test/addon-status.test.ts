import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamSource, downCallout, BUNDLED_ADDONS } from '../client/lib/addon-status.ts';
import { DEFAULT_ADDONS } from '../server/config.ts';
import type { AddonRow } from '../client/lib/api.ts';

const SUBS: AddonRow = { url: BUNDLED_ADDONS[0], name: 'Subtitles', resources: ['subtitles'], types: ['movie', 'series'], ok: true };
const STREAMS: AddonRow = { url: 'https://streams.example.com/abc/manifest.json', name: 'My streams', resources: ['stream'], types: ['movie', 'series'], ok: true };
/** How /api/addons lists an addon whose manifest did not load: its origin as the name, no resources. */
const down = (origin: string): AddonRow => ({ url: `${origin}/token/manifest.json`, name: origin, resources: [], types: [], ok: false, error: 'timed out' });

test('streamSource: a stream addon that answers is enough', () => {
  assert.deepEqual(streamSource([SUBS, STREAMS]), { kind: 'ok' });
  assert.deepEqual(streamSource([SUBS, STREAMS, down('https://other.example.com')]), { kind: 'ok' }, 'another one down does not matter');
  assert.deepEqual(streamSource([{ ...STREAMS, skipped: { failedAt: 1, reason: 'x' } }, { ...STREAMS, url: 'https://b.example.com/manifest.json' }]), { kind: 'ok' }, 'one skipped, one answering');
});

test('streamSource: nothing installed serves streams', () => {
  assert.deepEqual(streamSource([SUBS]), { kind: 'none' });
  assert.deepEqual(streamSource([]), { kind: 'none' }, 'every addon removed');
  assert.deepEqual(streamSource([{ ...SUBS, ok: false, resources: [], error: 'timed out' }]), { kind: 'none' }, 'the bundled subtitles addon down is not a missing stream addon');
});

test('streamSource: installed but not answering is not "none", and names them without the scheme', () => {
  assert.deepEqual(streamSource([SUBS, down('https://streams.example.com')]), { kind: 'down', names: ['streams.example.com'], sure: false });
  assert.deepEqual(streamSource([down('http://a.example.com'), SUBS, down('https://b.example.com')]), { kind: 'down', names: ['a.example.com', 'b.example.com'], sure: false });
  // Manifest loaded, but streams are being skipped for a minute: known to be the stream addon.
  assert.deepEqual(streamSource([SUBS, { ...STREAMS, skipped: { failedAt: 1, reason: 'timed out' } }, down('https://c.example.com')]), { kind: 'down', names: ['My streams'], sure: true });
});

test('downCallout: one or several, sure or not', () => {
  const one = downCallout({ names: ['streams.example.com'], sure: false });
  assert.equal(one.title, 'streams.example.com is not answering right now');
  assert.match(one.text, /^It is installed, but did not answer just now, so Kino cannot tell what it serves\. If it is your stream addon/);
  const two = downCallout({ names: ['a', 'b', 'c'], sure: false });
  assert.equal(two.title, 'a, b and c are not answering right now');
  assert.match(two.text, /^They are installed.*what they serve\. If one of them is your stream addon/);
  assert.match(downCallout({ names: ['My streams'], sure: true }).text, /^It is installed and serves streams, but did not answer just now/);
  assert.match(downCallout({ names: ['a', 'b'], sure: true }).text, /^They are installed and serve streams/);
});

test('BUNDLED_ADDONS mirrors the server default addons', () => {
  assert.deepEqual(BUNDLED_ADDONS, DEFAULT_ADDONS);
});
