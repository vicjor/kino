import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSink } from '../server/log.ts';

const tmp = (t: { after: (fn: () => void) => void }) => { const d = mkdtempSync(join(tmpdir(), 'kino-log-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const line = (n: number) => `${String(n).padStart(3, '0')}${'x'.repeat(36)}\n`;   // 40 bytes
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

test('rotates past maxBytes and keeps only the newest files', (t) => {
  const p = join(tmp(t), 'logs', 'kino.log');   // the folder does not exist yet
  const sink = fileSink(p, { maxBytes: 100, files: 3, onError: (e) => assert.fail(String(e)) });
  for (let n = 1; n <= 10; n++) sink.write(line(n));
  sink.close();
  // Two 40-byte lines fit in 100 bytes, the third starts a new file.
  assert.equal(read(p), line(9) + line(10));
  assert.equal(read(`${p}.1`), line(7) + line(8));
  assert.equal(read(`${p}.2`), line(5) + line(6));
  assert.equal(existsSync(`${p}.3`), false);
});

test('counts what is already in the file, and a line longer than maxBytes still lands', (t) => {
  const p = join(tmp(t), 'kino.log');
  writeFileSync(p, 'old'.repeat(30));   // 90 bytes from an earlier run
  const sink = fileSink(p, { maxBytes: 100, files: 2 });
  sink.write(line(1));
  const long = 'y'.repeat(150) + '\n';
  sink.write(long);
  sink.write(line(2));
  sink.close();
  assert.equal(read(`${p}.1`), long);
  assert.equal(read(p), line(2));
  // files: 2 keeps one old file: the earlier run's 90 bytes and line 1 are gone.
  assert.equal(existsSync(`${p}.2`), false);
});

test('files: 1 truncates in place', (t) => {
  const p = join(tmp(t), 'kino.log');
  const sink = fileSink(p, { maxBytes: 100, files: 1 });
  for (let n = 1; n <= 3; n++) sink.write(line(n));
  sink.close();
  assert.equal(read(p), line(3));
  assert.equal(existsSync(`${p}.1`), false);
});

test('an unwritable path reports once and never throws', (t) => {
  const d = tmp(t);
  writeFileSync(join(d, 'file'), '');
  const errors: unknown[] = [];
  const sink = fileSink(join(d, 'file', 'kino.log'), { onError: (e) => errors.push(e) });
  sink.write(line(1)); sink.write(line(2));
  sink.close();
  assert.equal(errors.length, 1);
});

test('KINO_LOG_FILE gets every line while stdout and stderr keep theirs', (t) => {
  const p = join(tmp(t), 'kino.log');
  const env: NodeJS.ProcessEnv = { ...process.env, KINO_LOG_FILE: p, LOG_LEVEL: 'info' };
  delete env.NODE_TEST_CONTEXT;
  const code = "import { logger } from './server/log.ts'; const l = logger('t'); l.debug('hidden'); l.info('hello', { n: 1 }); l.warn('careful');";
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
  assert.equal(r.status, 0, r.stderr);
  const msgs = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).msg);
  assert.deepEqual(msgs(r.stdout), ['hello']);
  assert.deepEqual(msgs(r.stderr), ['careful']);
  assert.deepEqual(msgs(read(p)), ['hello', 'careful']);
  assert.equal(JSON.parse(read(p).split('\n')[0]).n, 1);
});
