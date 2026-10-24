import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** WCAG 2 contrast for the colour tokens in global.css :root: text needs 4.5:1, icons and dots 3:1. */
const STYLES = path.resolve(import.meta.dirname, '..', 'client', 'styles');

/** `--name: #rrggbb` pairs from the first :root block. */
function tokens(css: string): Record<string, string> {
  const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  return Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

/** Relative luminance of an sRGB hex colour (WCAG 2). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('ratio: the WCAG reference points', () => {
  assert.equal(ratio('#ffffff', '#000000'), 21);
  assert.equal(ratio('#777777', '#777777'), 1);
  assert.equal(Math.round(ratio('#767676', '#ffffff') * 100) / 100, 4.54);
});

test('tokens: reads hex values from :root, not from later rules', () => {
  assert.deepEqual(tokens(':root {\n  --bg: #0C0D12;\n  --pad: 16px;\n  --ok: #5fc27a; /* x */\n}\n.a { --bg: #fff; }'), { bg: '#0c0d12', ok: '#5fc27a' });
});

const t = tokens(fs.readFileSync(path.join(STYLES, 'global.css'), 'utf8'));
const GROUNDS = ['bg', 'surface', 'raised'] as const;

test('text tokens pass 4.5:1 on every background', () => {
  const low: string[] = [];
  for (const fg of ['text', 'muted', 'accent', 'danger-text', 'warn', 'ok']) {
    for (const bg of GROUNDS) {
      assert.ok(t[fg] && t[bg], `--${fg} and --${bg} are in :root`);
      const r = ratio(t[fg], t[bg]);
      if (r < 4.5) low.push(`--${fg} on --${bg}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(low, []);
});

test('filled labels pass 4.5:1: ink on accent', () => {
  assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, 'accent-ink on accent');
});

test('icon and dot tokens pass 3:1 on the backgrounds they sit on', () => {
  for (const bg of GROUNDS) assert.ok(ratio(t.danger, t[bg]) >= 3, `--danger on --${bg}`);
  assert.ok(ratio(t.dim, t.bg) >= 3, '--dim on --bg');
});

/** Every `selector { ... color: var(--dim) }` outside comments, as `file: selector`. Disabled controls are exempt from contrast. */
function dimText(file: string, css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (/(^|[;\s])color:\s*var\(--dim\)/.test(m[2]) && !sel.split(',').every((s) => s.includes(':disabled'))) out.push(`${file}: ${sel}`);
  }
  return out;
}

test('dimText: flags text in --dim, not dots or disabled controls', () => {
  const css = '.a { color: var(--dim); }\n.b i { background: var(--dim); }\n.c:disabled { color: var(--dim); }\n@media (x) { .d, .e:disabled { font-size: 1px; color:var(--dim) } }\n/* .f { color: var(--dim) } */';
  assert.deepEqual(dimText('x.css', css), ['x.css: .a', 'x.css: .d, .e:disabled']);
});

test('client/styles: no text in --dim (it is 2.4:1 on --raised); use --muted', () => {
  const hits = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort().flatMap((f) => dimText(f, fs.readFileSync(path.join(STYLES, f), 'utf8')));
  assert.deepEqual(hits, []);
});

/** Every rule setting a ::placeholder colour, as `file: selector -> colour`, unless the colour is --muted or --text. */
function offTokenPlaceholders(file: string, css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const color = m[2].match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1].trim();
    if (sel.includes('::placeholder') && color && !/^var\(--(muted|text)\)$/.test(color)) out.push(`${file}: ${sel} -> ${color}`);
  }
  return out;
}

test('offTokenPlaceholders: flags a raw placeholder colour, not a token or another property', () => {
  const css = '.a::placeholder { color: #757575; }\n.b::placeholder { color: var(--muted); }\n.c::placeholder { opacity: .5; }\n.d { color: #757575; }';
  assert.deepEqual(offTokenPlaceholders('x.css', css), ['x.css: .a::placeholder -> #757575']);
});

test('placeholders: global.css draws them in --muted at full strength, no sheet picks a colour off the tokens', () => {
  const g = fs.readFileSync(path.join(STYLES, 'global.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(g, /(^|\n)::placeholder\s*\{\s*color:\s*var\(--muted\);\s*opacity:\s*1;\s*\}/, 'a bare ::placeholder default (Chrome draws #757575, 3.3:1 on --raised)');
  const off = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort().flatMap((f) => offTokenPlaceholders(f, fs.readFileSync(path.join(STYLES, f), 'utf8')));
  assert.deepEqual(off, []);
});
