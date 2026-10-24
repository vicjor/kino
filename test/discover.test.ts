import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seeds } from '../server/taste.ts';
import type { Progress } from '../server/types.ts';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = DIR;
const { usableBuild, pickSeeds, browseHref } = await import('../server/discover.ts');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 86400_000;
const NOW = Date.parse('2026-09-17T12:00:00Z');
const p = (o: Partial<Progress> & { metaId: string }): Progress => ({ videoId: o.metaId, type: 'series', pos: 2400, dur: 2500, updatedAt: NOW - DAY, name: o.metaId, ...o });

test('rails saved by an older build are not served after a deploy', () => {
  const rows = [{ key: 'popular', title: 'Popular now', items: [] }];
  const b = (fingerprint: unknown) => ({ at: 1, fingerprint, rows });
  assert.deepEqual(usableBuild(b('v3:k:tt1,tt2:20000'), 3), b('v3:k:tt1,tt2:20000'));
  assert.deepEqual(usableBuild(b('v3::::20000'), 3)?.rows, rows);                 // no key, nothing watched yet
  assert.equal(usableBuild(b('v2:k:tt1,tt2:20000'), 3), undefined);                // built before the bump
  assert.equal(usableBuild(b('v30:k:tt1:20000'), 3), undefined);                   // not fooled by a longer number
  assert.equal(usableBuild(b('v3'), 3), undefined);
  assert.equal(usableBuild(b(undefined), 3), undefined);
  assert.equal(usableBuild(b('v0:k:tt1:20000')), undefined);                        // default is the running version
  assert.equal(usableBuild({ at: 1, fingerprint: 'v3:k::1' }, 3), undefined);     // no rows
  for (const junk of [null, undefined, 'v3:', 42, []]) assert.equal(usableBuild(junk, 3), undefined);
});

test('pickSeeds keeps the two heaviest and rotates the third daily', () => {
  const s = seeds(['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => p({ metaId: id, updatedAt: NOW - i * DAY })), NOW);
  assert.deepEqual(pickSeeds(s, 0).map((x) => x.metaId), ['a', 'b', 'c']);
  assert.deepEqual(pickSeeds(s, 1).map((x) => x.metaId), ['a', 'b', 'd']);
  assert.deepEqual(pickSeeds(s, 2).map((x) => x.metaId), ['a', 'b', 'e']);
  assert.deepEqual(pickSeeds(s, 3).map((x) => x.metaId), ['a', 'b', 'c']);
  assert.deepEqual(pickSeeds(s.slice(0, 1), 4).map((x) => x.metaId), ['a']);
});

test('browseHref builds the Browse route the rails link to', () => {
  assert.equal(browseHref('all'), '#/browse/all');
  assert.equal(browseHref('series', { genre: 'Sci-Fi', sort: 'rated' }), '#/browse/series?genre=Sci-Fi&sort=rated');
  assert.equal(browseHref('movie', { genre: 'Thriller', sort: 'top' }), '#/browse/movie?genre=Thriller');
});
