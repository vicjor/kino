import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickLanIp } from '../server/config.ts';

test('en0 beats a Tailscale utun even when utun is listed first', () => {
  assert.equal(pickLanIp([{ name: 'utun8', addr: '100.101.102.103' }, { name: 'en0', addr: '192.168.1.144' }]), '192.168.1.144');
});

test('unknown adapter beats a VPN tunnel', () => {
  assert.equal(pickLanIp([{ name: 'utun3', addr: '10.8.0.2' }, { name: 'bridge100', addr: '192.168.64.1' }]), '192.168.64.1');
});

test('CGNAT address is last even under a plain name', () => {
  assert.equal(pickLanIp([{ name: 'foo', addr: '100.100.1.1' }, { name: 'bar', addr: '10.0.0.5' }]), '10.0.0.5');
});

test('falls back to the tunnel when it is all there is', () => {
  assert.equal(pickLanIp([{ name: 'utun8', addr: '100.101.102.103' }]), '100.101.102.103');
  assert.equal(pickLanIp([]), undefined);
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('importing config creates no folder; ensureDirs makes the data folders, twice is fine', async () => {
  const data = path.join(ROOT, 'data');
  const before = process.env.KINO_DATA;
  process.env.KINO_DATA = data;
  const spec = '../server/config.ts?dirs';   // a fresh module instance that reads this KINO_DATA
  const c = (await import(spec)) as typeof import('../server/config.ts');
  process.env.KINO_DATA = before;
  assert.equal(c.DATA_DIR, data);
  assert.equal(fs.existsSync(data), false);
  c.ensureDirs(); c.ensureDirs();
  for (const d of [c.DATA_DIR, c.CACHE_DIR, c.HLS_DIR, c.SUBS_DIR]) assert.ok(fs.statSync(d).isDirectory(), d);
});

const REPO = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8');
/** Each `process.env` use in src: the variable name, or `process.env` for a read by computed key or of the whole object. */
const envUses = (src: string): string[] => [...src.matchAll(/process\.env\b(?:\.([A-Z][A-Z0-9_]*))?/g)].map((m) => m[1] ?? 'process.env');
const sorted = (a: string[]) => [...new Set(a)].sort();

/** The names in README's `| Variable |` table: every `NAME` in the first column of each row. */
function readmeEnv(md: string): string[] {
  const lines = md.split('\n');
  const head = lines.findIndex((l) => /^\|\s*Variable\s*\|/.test(l));
  assert.ok(head >= 0, 'README has a | Variable | Default | What | table');
  const rows: string[] = [];
  for (const l of lines.slice(head + 2)) { if (!l.startsWith('|')) break; rows.push(l); }
  return sorted(rows.flatMap((r) => [...r.split('|')[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!)));
}

test('readmeEnv and envUses read their formats', () => {
  assert.deepEqual(readmeEnv('x\n| Variable | Default | What |\n|---|---|---|\n| `B_X`, `A` | `1` | uses `NOT_ME` |\n| `C` | | |\n\nafter `D`'), ['A', 'B_X', 'C']);
  assert.deepEqual(envUses("process.env.A_B || x; process.env['C']; f({ ...process.env })"), ['A_B', 'process.env', 'process.env']);
});

test('README Configuration lists exactly the variables config.ts reads', () => {
  const uses = envUses(read('server/config.ts'));
  assert.ok(!uses.includes('process.env'), 'config.ts reads each variable by name, so this test sees it');
  assert.deepEqual(readmeEnv(read('README.md')), sorted(uses));
});

test('every variable config.ts reads has a doc comment that starts with its name', () => {
  const documented = read('server/config.ts').split('\n').flatMap((l) => /^\s*\/\*\* ([A-Z0-9_, ]+):/.exec(l)?.[1]!.split(', ') ?? []);
  assert.deepEqual(sorted(envUses(read('server/config.ts'))).filter((n) => !documented.includes(n)), []);
});

/**
 * Reads still outside config.ts, as `file: NAME`. Each one moves to config.ts and leaves this list, which then stays
 * empty. hls.ts was someone else's work in progress: its KINO_NO_HW becomes NO_HW from config.ts once that lands.
 */
const NOT_MOVED_YET = ['server/media/hls.ts: KINO_NO_HW'];

test('only config.ts reads the environment in server/', () => {
  const files = (fs.readdirSync(path.join(REPO, 'server'), { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => `server/${f.split(path.sep).join('/')}`);
  const stray = files.filter((f) => f !== 'server/config.ts').flatMap((f) => envUses(read(f)).map((n) => `${f}: ${n}`));
  assert.deepEqual(stray.sort(), NOT_MOVED_YET, 'read it in server/config.ts with a doc comment starting with its name, list it in the README table, import it from there');
});
