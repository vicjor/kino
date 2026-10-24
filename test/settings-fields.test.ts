import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, fieldChange, type FieldKey } from '../client/lib/settings-fields.ts';
import { sanitizeSettings } from '../server/settings.ts';
import type { Settings } from '../server/types.ts';

const GB = 1024 ** 3;
const S = { addons: [], subLangs: ['eng'], cacheCapBytes: 10 * GB, minFreeBytes: 3 * GB, subFontSize: 100, autoNext: true, autoNextDelaySec: 10, tmdbApiKey: 'k1' } as Settings;

test('cache limit: typing 1 then 5 is one change to 15 GB when you leave the field, never 1 GB first', () => {
  // Nothing saves while you type (no change handler); leaving the field asks once, for what it says by then.
  assert.deepEqual(fieldChange('cacheCapBytes', '15', S), { cacheCapBytes: 15 * GB });
  assert.equal(fieldChange('cacheCapBytes', '10', S), null, 'what is saved already: no request');
  assert.equal(fieldChange('cacheCapBytes', '10.2', S), null, 'whole gigabytes, as the field shows them');
  assert.deepEqual(fieldChange('cacheCapBytes', '2.6', S), { cacheCapBytes: 3 * GB });
});

test('number fields: empty or garbled changes nothing, below the minimum is the minimum', () => {
  for (const k of ['cacheCapBytes', 'minFreeBytes', 'autoNextDelaySec'] as const) {
    for (const v of ['', '  ', 'abc', '1e999', '-']) assert.equal(fieldChange(k, v, S), null, `${k} ${JSON.stringify(v)}: no default saved over it`);
  }
  assert.deepEqual(fieldChange('cacheCapBytes', '0', S), { cacheCapBytes: GB });
  assert.deepEqual(fieldChange('cacheCapBytes', '-5', S), { cacheCapBytes: GB });
  assert.deepEqual(fieldChange('minFreeBytes', '0', S), { minFreeBytes: GB });
  assert.deepEqual(fieldChange('minFreeBytes', '20', S), { minFreeBytes: 20 * GB });
  assert.deepEqual(fieldChange('autoNextDelaySec', '2', S), { autoNextDelaySec: 3 });
  assert.deepEqual(fieldChange('autoNextDelaySec', '30', S), { autoNextDelaySec: 30 });
  assert.equal(fieldChange('autoNextDelaySec', '10', S), null);
});

test('number fields show what is saved, in the unit of the label', () => {
  assert.equal(FIELDS.cacheCapBytes.show(S), '10');
  assert.equal(FIELDS.minFreeBytes.show(S), '3');
  assert.equal(FIELDS.autoNextDelaySec.show(S), '10');
});

test('text fields: the same words in another spacing are no change; clearing one sends an empty text', () => {
  assert.equal(fieldChange('tmdbApiKey', ' k1 ', S), null);
  assert.deepEqual(fieldChange('tmdbApiKey', ' k2', S), { tmdbApiKey: 'k2' });
  assert.deepEqual(fieldChange('tmdbApiKey', '', S), { tmdbApiKey: '' });
  assert.equal(fieldChange('omdbApiKey', '  ', S), null, 'nothing saved, nothing typed');
});

test('every change a field makes is one the server takes, numbers as they are', () => {
  const typed: [FieldKey, string][] = [['cacheCapBytes', '15'], ['cacheCapBytes', '0'], ['minFreeBytes', '0'], ['minFreeBytes', '100'], ['autoNextDelaySec', '2'],
    ['tmdbApiKey', ''], ['omdbApiKey', 'abc'], ['haWebhookUrl', 'http://ha.local/api/webhook/k']];
  for (const [k, v] of typed) {
    const patch = fieldChange(k, v, S);
    assert.ok(patch, `${k} ${v}`);
    const { settings, errors } = sanitizeSettings(patch);
    assert.deepEqual(errors, [], `${k} ${v}`);
    if (/(Bytes|Sec)$/.test(k)) assert.deepEqual(settings, patch, `${k} ${v}`);
  }
});
