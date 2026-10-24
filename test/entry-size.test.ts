import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstLoad, sizeLine } from '../scripts/entry-size.ts';

const HTML = `<!doctype html><html><head>
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <script type="module" crossorigin src="/assets/index-BEe1IjWM.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-Ab12.js">
    <link rel="stylesheet" crossorigin href="/assets/index-DQH4p2wG.css">
  </head><body><div id="root"></div></body></html>`;

test('firstLoad: the entry script, its module preloads and stylesheets, nothing else', () => {
  assert.deepEqual(firstLoad(HTML), { js: ['/assets/index-BEe1IjWM.js', '/assets/vendor-Ab12.js'], css: ['/assets/index-DQH4p2wG.css'] });
});

test('firstLoad: a classic script or a non-asset link is not the entry chunk', () => {
  assert.deepEqual(firstLoad('<script src="/assets/legacy.js"></script><link rel="stylesheet" href="https://fonts.example/a.css">'), { js: [], css: [] });
});

test('sizeLine: sums raw and gzip sizes in kB', () => {
  assert.equal(sizeLine('js', [{ raw: 296_000, gzip: 93_000 }, { raw: 1_250, gzip: 600 }]), '297.3 kB js (gzip 93.6 kB)');
  assert.equal(sizeLine('css', []), '0.0 kB css (gzip 0.0 kB)');
});
