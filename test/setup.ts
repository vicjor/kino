/**
 * Preloaded by `bun run test` (`--import`) into the runner and into every test file's process, before any test module.
 * server/config.ts takes its paths from KINO_DATA on import, so this points KINO_DATA at a fresh temp dir and the suite
 * never reads or writes ~/kino-data. A test that wants its own folder still sets KINO_DATA and removes it in after().
 * Importing config creates no folder: a test that needs cache/, hls/ or subs/ calls ensureDirs() as the server's boot does.
 * config.ts reads the whole environment once, and every module that logs loads it (log.ts takes LOG_LEVEL from it), so a
 * test that sets KINO_DATA or LOG_LEVEL itself imports server modules after that, with await import().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kino-test-'));
process.env.KINO_DATA = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
