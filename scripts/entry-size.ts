/**
 * What a phone downloads before Home can paint: the entry chunk's JS and CSS that index.html asks for, raw and
 * gzipped. scripts/verify-build.ts prints it for every build, so code pulled back into the first load shows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/** The /assets/ files index.html loads up front: module scripts and their preloads, and stylesheets. */
export function firstLoad(html: string): { js: string[]; css: string[] } {
  const out = { js: [] as string[], css: [] as string[] };
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const url = /\b(?:src|href)="(\/assets\/[^"]+)"/.exec(tag)?.[1];
    if (!url) continue;
    if (/^<script\b/.test(tag) ? /\btype="module"/.test(tag) : /\brel="modulepreload"/.test(tag)) out.js.push(url);
    else if (/\brel="stylesheet"/.test(tag)) out.css.push(url);
  }
  return out;
}

const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;

/** "297.2 kB js (gzip 94.1 kB)" for a set of built files. */
export function sizeLine(kind: string, files: { raw: number; gzip: number }[]): string {
  const raw = files.reduce((a, f) => a + f.raw, 0);
  const gz = files.reduce((a, f) => a + f.gzip, 0);
  return `${kb(raw)} ${kind} (gzip ${kb(gz)})`;
}

/** "entry chunk: 297.2 kB js (gzip 94.1 kB) + 9.4 kB css (gzip 2.9 kB)" for the client build in `dir`. Throws when it has none. */
export function entryLine(dir: string): string {
  const html = path.join(dir, 'index.html');
  if (!fs.existsSync(html)) throw new Error(`no index.html in ${dir}`);
  const load = firstLoad(fs.readFileSync(html, 'utf8'));
  if (!load.js.length) throw new Error('index.html loads no module script');
  const sized = (urls: string[]) => urls.map((u) => { const b = fs.readFileSync(path.join(dir, u)); return { raw: b.length, gzip: gzipSync(b).length }; });
  return `entry chunk: ${sizeLine('js', sized(load.js))} + ${sizeLine('css', sized(load.css))}`;
}
