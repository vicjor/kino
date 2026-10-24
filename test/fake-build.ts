/**
 * A client build folder as vite writes it, without running vite: client/public copied in, sw.js with this build's
 * asset list filled in, an index.html that loads the entry chunk, and every bundle but those in `leave`.
 * For the tests of scripts/check-sw.ts, scripts/verify-build.ts and scripts/deploy-safe.sh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SW_ASSETS_MARK } from '../scripts/check-sw.ts';

const PUBLIC = path.resolve(import.meta.dirname, '../client/public');
/** The bundles of the fake build, as sw.js lists them. The first two are the entry chunk. */
export const FAKE_ASSETS = ['/assets/index-a1.js', '/assets/index-b2.css', '/assets/Player-c3.js'];
const INDEX = '<!doctype html><script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="stylesheet" crossorigin href="/assets/index-b2.css">\n';

export function fakeClient(dir: string, leave: string[] = []): string {
  fs.cpSync(PUBLIC, dir, { recursive: true });
  const sw = path.join(dir, 'sw.js');
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(SW_ASSETS_MARK, JSON.stringify(FAKE_ASSETS)));
  fs.mkdirSync(path.join(dir, 'assets'));
  const files: Record<string, string> = { '/index.html': INDEX, ...Object.fromEntries(FAKE_ASSETS.map((a) => [a, `/* ${a} */\n`])) };
  for (const [file, body] of Object.entries(files)) if (!leave.includes(file)) fs.writeFileSync(path.join(dir, file), body);
  return dir;
}
