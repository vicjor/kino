/**
 * Fails CI on a dependency advisory nobody has reviewed. Runs `bun audit --json` (it reads bun.lock, no install needed)
 * and compares it with the tables in docs/security-advisories.md: an advisory whose row says Accepted passes, anything
 * else fails, a row marked Fixed that bun reports again included. Accepted rows bun no longer reports are listed so the
 * table gets cleaned up, without failing.
 * Usage: node scripts/audit-gate.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DOC = 'docs/security-advisories.md';

/** One advisory bun audit reports for one package. */
export interface Finding { pkg: string; id: string; severity: string; title: string; url: string }
/** One row of a reviewed table. */
export interface Reviewed { pkg: string; id: string; accepted: boolean }

const GHSA = /GHSA(?:-[0-9a-z]{4}){3}/i;
const key = (pkg: string, id: string) => `${pkg} ${id}`.toLowerCase();

/** bun audit --json (`{ "<package>": [{ id, url, title, severity, ... }] }`) as one finding per package and advisory: bun repeats an advisory once per vulnerable range. */
export function findings(json: unknown): Finding[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('expected an object keyed by package name');
  const out = new Map<string, Finding>();
  for (const [pkg, list] of Object.entries(json as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`${pkg}: expected a list of advisories`);
    for (const a of list as Record<string, unknown>[]) {
      const url = String(a?.url ?? ''), id = GHSA.exec(url)?.[0] ?? `npm:${a?.id}`;
      if (!out.has(key(pkg, id))) out.set(key(pkg, id), { pkg, id, severity: String(a?.severity ?? '?'), title: String(a?.title ?? ''), url });
    }
  }
  return [...out.values()];
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Every row of every table whose header has Package, Advisory and Decision columns. Package is the first `code` name in its cell, Advisory the first GHSA id in its cell. */
export function reviewed(md: string): Reviewed[] {
  const out: Reviewed[] = [];
  let cols: { pkg: number; id: number; decision: number } | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { cols = null; continue; }
    const row = cells(line);
    if (!cols) {
      const at = (name: string) => row.findIndex((c) => c.toLowerCase() === name);
      cols = { pkg: at('package'), id: at('advisory'), decision: at('decision') };
      if (Object.values(cols).some((i) => i < 0)) cols = { pkg: -1, id: -1, decision: -1 };
      continue;
    }
    if (cols.pkg < 0 || row.every((c) => /^:?-+:?$/.test(c))) continue;
    const pkg = /`([^`]+)`/.exec(row[cols.pkg] ?? '')?.[1], id = GHSA.exec(row[cols.id] ?? '')?.[0];
    if (pkg && id) out.push({ pkg, id, accepted: /^\W*accepted\b/i.test(row[cols.decision] ?? '') });
  }
  return out;
}

/** What fails the gate (not reviewed, or marked fixed and back) and which Accepted rows bun no longer reports. */
export function gate(found: Finding[], rows: Reviewed[]): { failing: (Finding & { why: string })[]; stale: Reviewed[] } {
  const row = new Map(rows.map((r) => [key(r.pkg, r.id), r]));
  const failing = found.flatMap((f) => {
    const r = row.get(key(f.pkg, f.id));
    return r?.accepted ? [] : [{ ...f, why: r ? 'marked fixed, reported again' : 'not reviewed' }];
  });
  const now = new Set(found.map((f) => key(f.pkg, f.id)));
  return { failing, stale: rows.filter((r) => r.accepted && !now.has(key(r.pkg, r.id))) };
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const run = spawnSync('bun', ['audit', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  let found: Finding[];
  try {
    if (run.error) throw run.error;
    found = findings(run.stdout.trim() ? JSON.parse(run.stdout) : run.status === 0 ? {} : null);
  } catch (e) {
    console.error(`audit-gate: bun audit --json gave nothing usable (${(e as Error).message})`, run.stderr?.trim() ?? '');
    process.exit(2);
  }
  const { failing, stale } = gate(found, reviewed(fs.readFileSync(path.join(root, DOC), 'utf8')));
  for (const r of stale) console.log(`audit-gate: ${r.pkg} ${r.id} is Accepted in ${DOC} but no longer reported: drop the row or mark it Fixed`);
  if (failing.length) {
    console.error(`audit-gate: ${failing.length} advisor${failing.length === 1 ? 'y needs' : 'ies need'} a review. Fix, or add a row to ${DOC} (see "Reviewing a new one"):`);
    for (const f of failing) console.error(`  ${f.pkg} ${f.id} (${f.severity}, ${f.why}): ${f.title} ${f.url}`);
    process.exitCode = 1;
  } else console.log(`audit-gate: ${found.length} advisor${found.length === 1 ? 'y' : 'ies'}, every one reviewed in ${DOC}`);
}
