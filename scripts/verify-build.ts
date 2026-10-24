/**
 * Every check a client build must pass before it ships, in one place: `bun run build:check`, scripts/deploy-safe.sh
 * and make deploy-local all run this, so a check added to CHECKS reaches all three at once.
 * Prints what passed on stdout; on anything wrong prints why on stderr and exits 1.
 * Usage: node scripts/verify-build.ts <client build dir>
 */
import { checkSw } from './check-sw.ts';
import { entryLine } from './entry-size.ts';

/** What one check says about a build: a line when it passes, or the problems and what they would break. */
export type Verdict = { ok: string } | { breaks: string; wrong: string[] };

/** The checks, in the order they print. */
const CHECKS: ((dir: string) => Verdict | Promise<Verdict>)[] = [
  // The entry chunk's size, so code pulled back into the first load shows (scripts/entry-size.ts).
  (dir) => { try { return { ok: entryLine(dir) }; } catch (e) { return { breaks: 'phones would get a blank page', wrong: [(e as Error).message] }; } },
  // sw.js pre-caches only files the build has: one 404 fails the whole install (scripts/check-sw.ts).
  async (dir) => {
    const wrong = await checkSw(dir);
    return wrong.length ? { breaks: "every phone's service worker update would fail", wrong } : { ok: 'sw.js: every file it pre-caches is in the build' };
  },
];

export const verifyBuild = (dir: string): Promise<Verdict[]> => Promise.all(CHECKS.map((c) => c(dir)));

/** The verdicts as lines: passes for stdout, problems for stderr (empty when the build may ship). */
export function report(verdicts: Verdict[]): { out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  for (const v of verdicts) {
    if ('ok' in v) out.push(v.ok);
    else err.push(`verify-build: ${v.breaks}:`, ...v.wrong.map((w) => `  ${w}`));
  }
  return { out, err };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/verify-build.ts <client build dir>'); process.exit(2); }
  const { out, err } = report(await verifyBuild(dir));
  if (out.length) console.log(out.join('\n'));
  if (err.length) { console.error(err.join('\n')); process.exitCode = 1; }
}
