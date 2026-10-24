import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A spinner on its own (className="spinner", not the small ones inside a labelled button) is a status named
 * Loading, so a screen reader can say the screen is waiting for something.
 */
const CLIENT = path.resolve(import.meta.dirname, '..', 'client');

/** TODO: files another session owns, still holding an unnamed spinner. The staleness test says when one is clean. */
const ALLOW = new Set(['App.tsx', 'screens/Player.tsx']);

/** `file: tag` for every spinner without role="status" and an aria-label. */
function unnamedSpinners(file: string, src: string): string[] {
  return [...src.matchAll(/<(?:div|span) className="spinner"([^>]*?)\/>/g)]
    .filter((m) => !/\brole="status"/.test(m[1]) || !/\baria-label=/.test(m[1]))
    .map((m) => `${file}: ${m[0]}`);
}

function sources(dir = CLIENT): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(path.join(dir, d.name)) : d.name.endsWith('.tsx') ? [path.relative(CLIENT, path.join(dir, d.name))] : []));
}

test('unnamedSpinners: flags a bare spinner, not a named one or the small ones in buttons', () => {
  const src = '<div className="spinner" />\n<div className="spinner" role="status" aria-label="Loading" />\n<span className="spinner sm" />\n<span className="spinner" role="status" />';
  assert.deepEqual(unnamedSpinners('x.tsx', src), ['x.tsx: <div className="spinner" />', 'x.tsx: <span className="spinner" role="status" />']);
});

test('client: every spinner on its own is a status with a name, less the TODO allowlist', () => {
  const hits = sources().filter((f) => !ALLOW.has(f)).flatMap((f) => unnamedSpinners(f, fs.readFileSync(path.join(CLIENT, f), 'utf8')));
  assert.deepEqual(hits, [], 'add role="status" aria-label="Loading"');
});

test('every allowlisted file still holds an unnamed spinner, so clean ones leave the list', () => {
  const clean = [...ALLOW].filter((f) => !fs.existsSync(path.join(CLIENT, f)) || !unnamedSpinners(f, fs.readFileSync(path.join(CLIENT, f), 'utf8')).length);
  assert.deepEqual(clean, []);
});
