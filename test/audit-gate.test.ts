import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DOC, findings, reviewed, gate, type Finding } from '../scripts/audit-gate.ts';

const adv = (ghsa: string, range: string, severity = 'high') => ({ id: 1, url: `https://github.com/advisories/${ghsa}`, title: `t ${ghsa}`, severity, vulnerable_versions: range });

test('findings: one per package and advisory, though bun repeats it per vulnerable range', () => {
  const f = findings({ 'brace-expansion': [adv('GHSA-6j4f-fj2g-mc7p', '<1.1.19'), adv('GHSA-6j4f-fj2g-mc7p', '>=2.0.0 <2.1.5'), adv('GHSA-qhr7-859c-m2p7', '<1.1.20')], ip: [adv('GHSA-2p57-rm9w-gvfp', '<=2.0.1')] });
  assert.deepEqual(f.map((x) => `${x.pkg} ${x.id}`), ['brace-expansion GHSA-6j4f-fj2g-mc7p', 'brace-expansion GHSA-qhr7-859c-m2p7', 'ip GHSA-2p57-rm9w-gvfp']);
  assert.deepEqual(findings({}), []);
  assert.equal(findings({ x: [{ id: 42, url: '', severity: 'low', title: 'no ghsa' }] })[0].id, 'npm:42');
});

test('findings: anything but the bun audit shape throws, so a broken audit never passes as clean', () => {
  for (const bad of [null, [], 'oops', { ip: 'nope' }]) assert.throws(() => findings(bad));
});

const MD = `# x

| Package | Advisory | Severity | Decision |
|---|---|---|---|
| \`ip\` 2.0.1 | [GHSA-2p57-rm9w-gvfp](u): isPublic | high | **Accepted**: unreachable |
| \`fast-uri\` 3.1.7 | [GHSA-hrr3-gc8f-f4qj](u) | moderate | **Fixed**: bump |
| no package cell | GHSA-aaaa-bbbb-cccc | low | Accepted |

| Name | Thing |
|---|---|
| \`ip\` | GHSA-zzzz-zzzz-zzzz |

| Decision | Package | Advisory |
|---|---|---|
| Accepted, later | \`protobufjs\` 6.11.6 | see GHSA-685m-2w69-288q |
`;

test('reviewed: rows of tables with Package, Advisory and Decision columns, in any order', () => {
  assert.deepEqual(reviewed(MD), [
    { pkg: 'ip', id: 'GHSA-2p57-rm9w-gvfp', accepted: true },
    { pkg: 'fast-uri', id: 'GHSA-hrr3-gc8f-f4qj', accepted: false },
    { pkg: 'protobufjs', id: 'GHSA-685m-2w69-288q', accepted: true },
  ]);
});

const finding = (pkg: string, id: string): Finding => ({ pkg, id, severity: 'high', title: 't', url: 'u' });

test('gate: Accepted passes, unknown and fixed-but-back fail, Accepted rows no longer reported are stale', () => {
  const { failing, stale } = gate([finding('ip', 'GHSA-2p57-rm9w-gvfp'), finding('fast-uri', 'ghsa-hrr3-gc8f-f4qj'), finding('ws', 'GHSA-1111-2222-3333')], reviewed(MD));
  assert.deepEqual(failing.map((f) => `${f.pkg}: ${f.why}`), ['fast-uri: marked fixed, reported again', 'ws: not reviewed']);
  assert.deepEqual(stale.map((r) => r.pkg), ['protobufjs']);
});

test('gate: an advisory accepted for one package does not cover another package', () => {
  assert.equal(gate([finding('ip-address', 'GHSA-2p57-rm9w-gvfp')], reviewed(MD)).failing.length, 1);
});

test(`${DOC}: every table row is one the gate reads, once, as Accepted or Fixed`, () => {
  const md = fs.readFileSync(path.resolve(import.meta.dirname, '..', DOC), 'utf8');
  const rows = md.split('\n').filter((l) => /^\| `/.test(l));
  const read = reviewed(md);
  assert.equal(read.length, rows.length, 'a row without a `package` or a GHSA id is invisible to the gate');
  assert.equal(new Set(read.map((r) => `${r.pkg} ${r.id}`)).size, read.length, 'one row per package and advisory');
  for (const l of rows) assert.match(l.split('|').at(-2)!, /^\s*\*\*(Accepted|Fixed)\*\*/, l.slice(0, 80));
});
