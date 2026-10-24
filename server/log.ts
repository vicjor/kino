import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOG_FILE, LOG_LEVEL } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[LOG_LEVEL as Level] ?? 20;

const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILES = 3;
export interface FileSink { write(line: string): void; close(): void }
export interface FileSinkOpts { maxBytes?: number; files?: number; onError?: (e: unknown) => void }

/** Append lines to `path`. A write that would pass `maxBytes` first moves the file to `path.1` (`.1` to `.2`
 *  and so on, the oldest dropped), keeping `files` files in all. Never throws: on the first error it calls
 *  `onError` (default: one line on stderr) and stops writing. Opens the file on the first write. */
export function fileSink(path: string, { maxBytes = LOG_MAX_BYTES, files = LOG_FILES, onError = sinkFailed(path) }: FileSinkOpts = {}): FileSink {
  let fd = -1, size = 0, dead = false;
  const open = (flags: 'a' | 'w') => { mkdirSync(dirname(path), { recursive: true }); fd = openSync(path, flags); size = fstatSync(fd).size; };
  const close = () => { if (fd >= 0) try { closeSync(fd); } catch { /* already gone */ } fd = -1; };
  const rotate = () => {
    close();
    for (let i = files - 1; i >= 1; i--) {
      try { renameSync(i === 1 ? path : `${path}.${i - 1}`, `${path}.${i}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    open(files > 1 ? 'a' : 'w');
  };
  return {
    write(line) {
      if (dead) return;
      try {
        if (fd < 0) open('a');
        const buf = Buffer.from(line);
        if (size > 0 && size + buf.length > maxBytes) rotate();
        writeSync(fd, buf); size += buf.length;
      } catch (e) { dead = true; close(); onError(e); }
    },
    close,
  };
}
function sinkFailed(path: string) {
  return (e: unknown) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', mod: 'log', msg: 'log file disabled', path, err: errMsg(e) }) + '\n');
}

/** KINO_LOG_FILE: also append every line there, rotated at 10 MB with 3 files kept (the desktop app sets it). */
const file = LOG_FILE ? fileSink(LOG_FILE) : undefined;

function emit(level: Level, mod: string, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, mod, msg, ...(extra || {}) }) + '\n';
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  file?.write(line);
}

export function logger(mod: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', mod, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', mod, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', mod, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', mod, msg, extra),
  };
}
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
