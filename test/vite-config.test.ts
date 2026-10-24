import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import config, { cacheDirFor } from '../vite.config.ts';

test('cacheDirFor: one vite cache per checkout, inside its node_modules, named after the folder', () => {
  const main = '/Users/me/dev/kino', tree = '/Users/me/dev/kino/.claude/worktrees/agent-a1';
  assert.equal(cacheDirFor(main), cacheDirFor(main), 'the same checkout keeps its cache');
  assert.notEqual(cacheDirFor(main), cacheDirFor(tree));
  assert.notEqual(cacheDirFor('/a/kino'), cacheDirFor('/b/kino'), 'same folder name elsewhere');
  assert.match(cacheDirFor(tree), /^\/Users\/me\/dev\/kino\/\.claude\/worktrees\/agent-a1\/node_modules\/\.vite-agent-a1-[0-9a-f]{8}$/);
});

test('the config uses the cache of the checkout it lives in', () => {
  assert.equal((config as { cacheDir?: string }).cacheDir, cacheDirFor(path.resolve(import.meta.dirname, '..')));
});
