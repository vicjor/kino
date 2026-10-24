import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const STYLES = path.resolve(import.meta.dirname, '..', 'client', 'styles');

/**
 * Raw values that have a token in global.css :root. Outside :root they go through the token:
 * curves as var(--ease) and friends, colors as var(--danger-text), var(--warn), var(--glass-bg).
 */
const RAW: { re: RegExp; use: string }[] = [
  { re: /cubic-bezier\(/i, use: 'var(--ease), var(--ease-exit), var(--ease-sheet-exit) or var(--ease-dock)' },
  { re: /#f08a84\b/i, use: 'var(--danger-text)' },
  { re: /#f0c084\b/i, use: 'var(--warn)' },
  { re: /rgba\(\s*18\s*,\s*20\s*,\s*27\s*,\s*0?\.72\s*\)/i, use: 'var(--glass-bg)' },
];

/**
 * TODO: files another session owns, still holding raw values. Remove an entry once its file is clean
 * (the staleness test below says when).
 */
const ALLOW = new Set<string>();

/** Blank out comments and :root blocks, keeping line breaks so line numbers still match the file. */
function strip(css: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return css.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/:root\b[^{]*\{[^}]*\}/g, blank);
}

/** `file:line: text -> token` for every raw value outside :root and comments. */
function rawValues(file: string, css: string): string[] {
  const out: string[] = [];
  strip(css).split('\n').forEach((line, i) => {
    for (const r of RAW) if (r.re.test(line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)} -> ${r.use}`);
  });
  return out;
}

const sheets = () => fs.readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort();

test('rawValues: flags raw curves and colors, not their :root definitions or comments', () => {
  const css = [
    ':root {',
    '  --ease: cubic-bezier(.32,.72,0,1);',
    '  --glass-bg: rgba(18,20,27,.72);',
    '}',
    '/* was cubic-bezier(.32,.72,0,1) and #F0C084 */',
    '.a { transition: transform .2s var(--ease); color: var(--warn); }',
    '.b { transition: opacity .2s cubic-bezier(.4,0,.6,1); }',
    '.c { color: #F08A84; background: rgba(18, 20, 27, 0.72); }',
    '.e { color: #f0c0841a; }',
  ].join('\n');
  assert.deepEqual(rawValues('x.css', css).map((h) => h.split(': ')[0] + ' ' + h.split(' -> ')[1]), [
    'x.css:7 var(--ease), var(--ease-exit), var(--ease-sheet-exit) or var(--ease-dock)',
    'x.css:8 var(--danger-text)',
    'x.css:8 var(--glass-bg)',
  ]);
});

test('client/styles: no raw curve or token color outside :root, less the TODO allowlist', () => {
  const hits = sheets().filter((f) => !ALLOW.has(f)).flatMap((f) => rawValues(f, fs.readFileSync(path.join(STYLES, f), 'utf8')));
  assert.deepEqual(hits, [], 'Use the token from global.css :root');
});

test('every allowlisted stylesheet still holds a raw value, so clean ones leave the list', () => {
  const clean = [...ALLOW].filter((f) => !fs.existsSync(path.join(STYLES, f)) || !rawValues(f, fs.readFileSync(path.join(STYLES, f), 'utf8')).length);
  assert.deepEqual(clean, []);
});
