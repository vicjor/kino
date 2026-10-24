import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMacApp } from '../client/lib/shell';

test('isMacApp: Kino.app on a Mac only', () => {
  assert.equal(isMacApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kino/0.2.0 Chrome/140.0.0.0 Electron/38.1.0 Safari/537.36'), true);
  assert.equal(isMacApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'), false);
  assert.equal(isMacApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Kino/0.2.0 Chrome/140.0.0.0 Electron/38.1.0 Safari/537.36'), false);
  assert.equal(isMacApp('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'), false);
});
