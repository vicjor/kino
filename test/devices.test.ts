import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thisDeviceName } from '../client/lib/devices.ts';

test('thisDeviceName: names the screen the way its owner calls it', () => {
  assert.equal(thisDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', 5), 'This iPhone');
  assert.equal(thisDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 5), 'This iPad', 'iPadOS says Macintosh, the touch screen gives it away');
  assert.equal(thisDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome', 0), 'This Mac');
  assert.equal(thisDeviceName('Mozilla/5.0 (Linux; Android 15; Pixel) Mobile Safari'), 'This phone');
  assert.equal(thisDeviceName('Mozilla/5.0 (Linux; Android 15; Tab) Safari'), 'This tablet');
  assert.equal(thisDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'This computer');
});
