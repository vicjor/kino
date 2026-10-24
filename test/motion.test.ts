import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scrollBehavior } from '../client/lib/motion.ts';

test('scrollBehavior: a jump under reduced motion, smooth otherwise', () => {
  const asked: string[] = [];
  assert.equal(scrollBehavior((q) => { asked.push(q); return { matches: true }; }), 'auto');
  assert.equal(scrollBehavior(() => ({ matches: false })), 'smooth');
  assert.deepEqual(asked, ['(prefers-reduced-motion: reduce)']);
});

test('client: scripted scrolls ask scrollBehavior() instead of a hard-coded smooth', () => {
  const root = path.resolve(import.meta.dirname, '..', 'client');
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(path.join('lib', 'motion.ts')));
  const hits = files.filter((f) => /behavior:\s*['"]smooth['"]/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(hits, []);
});
