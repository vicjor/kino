import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type WebTorrent from 'webtorrent';
import { dropStuckPmp, shutdown, setClientForTests } from '../server/torrent.ts';

const pmp = (busy: boolean) => { const c = { _reqActive: busy, closed: 0, close: async () => { c.closed++; } }; return c; };

test('dropStuckPmp: a NAT-PMP client stuck on an unanswered request is closed and dropped', () => {
  const stuck = pmp(true); const nat = { _pmpClient: stuck as typeof stuck | null };
  assert.equal(dropStuckPmp(nat), true);
  assert.equal(nat._pmpClient, null);
  assert.equal(stuck.closed, 1);
  const idle = pmp(false); const fine = { _pmpClient: idle };
  assert.equal(dropStuckPmp(fine), false, 'a router that answers keeps NAT-PMP');
  assert.equal(fine._pmpClient, idle);
  for (const x of [undefined, null, false, {}, { _pmpClient: null }]) assert.equal(dropStuckPmp(x), false);
});

test('shutdown drops the stuck NAT-PMP client before the webtorrent client is destroyed', async () => {
  const nat = { _pmpClient: pmp(true) as ReturnType<typeof pmp> | null };
  let atDestroy: unknown = 'not destroyed';
  setClientForTests({ natTraversal: nat, destroy: (cb: () => void) => { atDestroy = nat._pmpClient; cb(); } } as unknown as WebTorrent);
  try { await shutdown(); } finally { setClientForTests(null); }
  assert.equal(atDestroy, null);
});

// dropStuckPmp reads nat-api internals. An upgrade that renames them only brings the slow shutdown back, so say so here.
test('nat-api still has the internals dropStuckPmp reads', () => {
  const req = createRequire(fileURLToPath(import.meta.resolve('webtorrent')));
  const dir = path.dirname(req.resolve('@silentbot1/nat-api/package.json'));
  const api = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const client = fs.readFileSync(path.join(dir, 'lib/pmp/index.js'), 'utf8');
  assert.match(api, /if \(this\._pmpClient\) \{\s*const pmpSuccess = await this\._pmpUnmap/, 'unmap tries NAT-PMP only while _pmpClient is set');
  assert.match(client, /if \(this\._reqActive\) \{\s*debug\('_next: already an active request so wait/, 'a request waits behind an unanswered one');
  assert.match(fs.readFileSync(fileURLToPath(import.meta.resolve('webtorrent')), 'utf8'), /this\.natTraversal = new NatAPI/);
});
