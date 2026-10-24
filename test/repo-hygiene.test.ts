import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
/** En dash (U+2013) and em dash (U+2014). Written as escapes so this file passes its own check. */
const DASH = /[\u2013\u2014]/;
const SKIP = new Set(['bun.lock']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|mp4|mov|dmg|zip|gz)$/i;

/**
 * Lines allowed to keep a dash, by file and exact line content: only upstream data a parser has to read as it comes.
 * Anything else gets a period, comma, colon or parentheses instead.
 */
const ALLOW: { file: string; line: string }[] = [];

/** Every tracked text file's lines holding an en or em dash, as `file:line: text`, less the allowlist. */
function dashLines(): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const out: string[] = [];
  for (const file of files) {
    if (SKIP.has(file) || BINARY.test(file)) continue;
    let buf: Buffer;
    try { buf = fs.readFileSync(path.join(ROOT, file)); } catch { continue; }   // deleted in the work tree
    if (buf.includes(0)) continue;   // binary without a known extension
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      if (DASH.test(line) && !ALLOW.some((a) => a.file === file && a.line === line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return out;
}

test('no en or em dash in any tracked file, outside the upstream data allowlist', () => {
  assert.deepEqual(dashLines(), [], 'Use a period, comma, colon or parentheses instead (AGENTS.md conventions)');
});

test('every allowlist entry still matches a line, so stale entries get removed', () => {
  const stale = ALLOW.filter((a) => {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, a.file), 'utf8'); } catch { return true; }
    return !text.split(/\r?\n/).includes(a.line);
  });
  assert.deepEqual(stale, []);
});

/** Files under test/ that make a temp dir and do not remove it in after() or afterEach(), with the reason. */
const TEMP_ALLOW: Record<string, string> = {
  'test/setup.ts': 'the preload: no test context, it removes its dir on process exit',
};

/** Each after(...), afterEach(...) or t.after(...) call in src, from the name to its matching close paren. */
function afterCalls(src: string): string[] {
  return [...src.matchAll(/\bafter(?:Each)?\(/g)].map((m) => {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    return src.slice(m.index, i + 1);
  });
}

/** A text heuristic: the file calls mkdtemp or mkdtempSync, and no after hook calls rm or rmSync. */
const leaksTempDir = (src: string) => /\bmkdtemp(?:Sync)?\(/.test(src) && !afterCalls(src).some((c) => /\brm(?:Sync)?\(/.test(c));

/** Every .ts file under test/ (tracked or not, as `bun run test` runs them) that leaks a temp dir. Not this file: its samples are text. */
function tempLeaks(): string[] {
  const dir = path.join(ROOT, 'test');
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))
    .map((f) => `test/${f.split(path.sep).join('/')}`)
    .filter((f) => f !== 'test/repo-hygiene.test.ts' && leaksTempDir(fs.readFileSync(path.join(ROOT, f), 'utf8')));
}

test('leaksTempDir: a temp dir needs an rm or rmSync in an after or afterEach hook', () => {
  const mk = "const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));\n";
  assert.equal(leaksTempDir(mk), true);
  assert.equal(leaksTempDir(mk + "after(() => { server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });"), false);
  assert.equal(leaksTempDir(mk + "afterEach(async () => {\n  await rm(DIR, { recursive: true });\n});"), false);
  assert.equal(leaksTempDir("const d = mkdtempSync('x'); t.after(() => rmSync(d, { recursive: true }));"), false);
  assert.equal(leaksTempDir(mk + "after(() => { server.close(); });\ntest('x', () => { fs.rmSync(DIR); });"), true, 'rm outside the hook does not count');
  assert.equal(leaksTempDir("const d = await mkdtemp('x');"), true);
  assert.equal(leaksTempDir("after(() => { server.close(); });"), false, 'no temp dir, nothing to remove');
});

test('every test file that makes a temp dir removes it in after() or afterEach()', () => {
  assert.deepEqual(tempLeaks().filter((f) => !Object.hasOwn(TEMP_ALLOW, f)), [], 'rmSync the temp dir in after() (AGENTS.md conventions), or allowlist the file with a reason');
});

test('every temp dir allowlist entry still leaks, so stale entries get removed', () => {
  const leaks = new Set(tempLeaks());
  assert.deepEqual(Object.keys(TEMP_ALLOW).filter((f) => !leaks.has(f)), []);
});

/** The server/ part of the fenced block under README's "Repo layout": the `server/` line up to the next top-level entry. */
function serverLayout(readme: string): string {
  const lines = (readme.split(/^### Repo layout$/m)[1]?.split('```')[1] ?? '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('server/'));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether the layout names a file under server/: by path (`cast/dnssd.ts`, with or without `server/`), file name or name without .ts, as a whole word. */
function namedIn(layout: string, file: string): boolean {
  const rel = file.replace(/^server\//, ''), base = path.posix.basename(rel), stem = base.replace(/\.ts$/, '');
  return [file, rel, base, stem].some((n) => new RegExp(`(?<![\\w./-])${escRe(n)}(?![\\w-])`).test(layout));
}

/** Every .ts file under server/ (tracked or not, as the build compiles them), less the .d.ts shims in server/types/. */
const serverFiles = () => (fs.readdirSync(path.join(ROOT, 'server'), { recursive: true }) as string[])
  .map((f) => `server/${f.split(path.sep).join('/')}`).filter((f) => f.endsWith('.ts') && !/^server\/types\/[^/]+\.d\.ts$/.test(f)).sort();

test('namedIn: a path, a file name or a bare name, never part of a longer one', () => {
  const layout = 'server/\n  home.ts          Home\n  media/           bins, probe, credits\n  cast/dnssd.ts    dns-sd\n  ha.ts disk.ts    webhook';
  for (const f of ['server/home.ts', 'server/media/probe.ts', 'server/media/credits.ts', 'server/cast/dnssd.ts', 'server/disk.ts']) assert.equal(namedIn(layout, f), true, f);
  for (const f of ['server/media/credits-lookup.ts', 'server/cast/dns.ts', 'server/dnssd2.ts', 'server/sd.ts', 'server/me.ts']) assert.equal(namedIn(layout, f), false, f);
  assert.equal(serverLayout('# x\n### Repo layout\n\n```\nserver/  api\n  a.ts  A\nclient/  ui\n  b.ts  B\n```\n'), 'server/  api\n  a.ts  A');
});

/**
 * Files under server/ allowed to throw copy written for people as a plain Error, with the reason. Such an error names
 * no status, so jsonErrors answers the generic "Something went wrong" sentence instead of its words.
 */
const PLAIN_THROW_ALLOW: Record<string, string> = {};

/**
 * Each `throw new Error(...` or `Promise.reject(new Error(...` in src whose text reads as copy for people, as `file:line: text`:
 * a literal starting with a capital, or a template starting with a variable followed by words (`${dev.name} refused the
 * stream: ...`). Copy that carries no status. A variable followed by one word or by another variable ("${status} for ${url}")
 * is library-style text for the log, not a sentence.
 */
function plainThrows(file: string, src: string): string[] {
  return [...src.matchAll(/(?:\bthrow|\bPromise\.reject\()\s*new Error\(\s*(?:['"`]\p{Lu}|`\$\{[^}`]*\}(?:'s)?\s+\p{L}+\s+\p{L})/gu)].map((m) => {
    const line = src.slice(0, m.index).split('\n').length;
    return `${file}:${line}: ${src.split('\n')[line - 1].trim().slice(0, 160)}`;
  });
}
const allPlainThrows = () => serverFiles().flatMap((f) => plainThrows(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));

test('plainThrows: a capitalised literal, or a variable followed by words, thrown or rejected as a plain Error, nothing else', () => {
  for (const src of ["throw new Error('TV not found');", 'if (x) throw new Error(`Chromecast refused the stream: ${m}`);', 'return Promise.reject(new Error("Not connected"));', "throw new Error(\n  'Spread over lines');",
    'throw new Error(`${dev.name} refused the stream: ${errMsg(e)}`);', 'return Promise.reject(new Error(`${name} is offline`));', "throw new Error(`${dev.name}'s player closed`);", 'throw new Error(\n  `${tv} did not answer`);']) assert.equal(plainThrows('f.ts', src).length, 1, src);
  for (const src of ["throw new Error('launch failed');", 'throw new Error(`${name} refused`);', "throw httpError(404, 'TV not found');", "throw Object.assign(new Error('Not an info hash'), { status: 400 });", 'throw new Error(reason);', "fail(new Error('Chromecast connect timeout'));",
    'throw new Error(`${res.status} for ${f}`);', 'throw new Error(`${r.status} ${r.statusText} for ${url}`);', 'throw new Error(`${action} failed: ${desc}`);', "reject(new Error(`${label} timed out after ${s} s`));", 'throw httpError(503, `${name} is offline`);']) assert.deepEqual(plainThrows('f.ts', src), [], src);
  assert.deepEqual(plainThrows('f.ts', "a();\n  throw new Error('Gone');"), ["f.ts:2: throw new Error('Gone');"]);
});

test('no copy for people thrown as a plain Error under server/: it needs a status (httpError)', () => {
  assert.deepEqual(allPlainThrows().filter((h) => !Object.hasOwn(PLAIN_THROW_ALLOW, h.split(':')[0])), [], 'throw httpError(status, words) so jsonErrors shows the words, or allowlist the file with a reason');
});

test('every plain throw allowlist entry still has one, so stale entries get removed', () => {
  const files = new Set(allPlainThrows().map((h) => h.split(':')[0]));
  assert.deepEqual(Object.keys(PLAIN_THROW_ALLOW).filter((f) => !files.has(f)), []);
});

test('README repo layout names every server module', () => {
  const layout = serverLayout(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  assert.ok(layout.includes('index.ts'), 'found the server part of the Repo layout block');
  assert.deepEqual(serverFiles().filter((f) => !namedIn(layout, f)), [], 'add one line per file to README "Repo layout", or name it in its folder entry');
});
