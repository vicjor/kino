import type { Request, Response, NextFunction } from 'express';
import { logger, errMsg } from './log.js';
import type { ErrorCode } from './types.js';

const log = logger('http');

/** An error the JSON error handler answers with its own status and message, and its `code` when it has one. */
export type HttpError = Error & { status: number; code?: ErrorCode };
export function httpError(status: number, msg: string, code?: ErrorCode): HttpError {
  const e: HttpError = Object.assign(new Error(msg), { status });
  if (code) e.code = code;
  return e;
}

const CODES: Record<ErrorCode, true> = { 'no-peers': true, 'unreadable': true, 'disk-full': true, 'tool-broken': true, 'transcode-failed': true, 'session-gone': true };
/** The ErrorCode an error carries. Only Kino's own: a system error's `code` (ENOENT, ECONNRESET) is not one and stays in the log. */
export function codeOf(e: unknown): ErrorCode | undefined {
  const c = (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined);
  return typeof c === 'string' && Object.hasOwn(CODES, c) ? c as ErrorCode : undefined;
}

/** `__proto__`, `constructor`, `toString` and the rest: as a key in a plain object they reach Object.prototype. */
const unsafe = (x: string) => x === 'prototype' || x in Object.prototype;
/**
 * Whether a string can be a key in a state map (progress, credits, intros, cast history). No part between
 * colons may be a name Object.prototype has: a video id's first part becomes a meta id key too.
 */
export const isSafeKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 512 && !k.split(':').some(unsafe);
/** A request value that becomes a state key, or a 400. */
export function safeKey(v: unknown, what: string): string {
  if (!isSafeKey(v)) throw httpError(400, `Not a valid ${what}`);
  return v;
}

/** The HTTP error status an error names itself (ours, the body parser's, DiskFullError's 507), if it names one. */
export function ownStatus(e: unknown): number | undefined {
  const x = (e && typeof e === 'object' ? e : {}) as { status?: unknown; statusCode?: unknown };
  const s = Number(x.status ?? x.statusCode);
  return Number.isInteger(s) && s >= 400 && s < 600 ? s : undefined;
}
/** The status an error carries, or 500 when it has none that makes sense. */
export const statusOf = (e: unknown): number => ownStatus(e) ?? 500;

const PARSER: Record<string, string> = { 'entity.parse.failed': 'The request body is not valid JSON', 'entity.too.large': 'The request body is too large' };

/** What a 500 says when the error named no status: a bug or a surprise, whose own text (paths, upstream URLs) is for the log. */
export const UNEXPECTED = 'Something went wrong on the Mac running Kino. The log has the details.';
/**
 * The text an error answer carries. An error that names its status was written for the person asking (httpError and
 * the like), unless it says otherwise (`expose: false`, how http-errors marks a library's 5xx). Anything else is UNEXPECTED.
 */
export function publicMessage(e: unknown): string {
  const type = (e as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && PARSER[type]) return PARSER[type];
  return ownStatus(e) !== undefined && (e as { expose?: unknown }).expose !== false ? errMsg(e) : UNEXPECTED;
}

/**
 * Every error as `{ error }` JSON, plus `code` when it has one (codeOf). Mounted on the app, not the API router, so a
 * body the JSON parser refuses gets JSON too instead of Express's HTML page. An unexpected error is logged with its stack.
 */
export function jsonErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const status = statusOf(err); const error = publicMessage(err); const code = codeOf(err);
  const where = { method: req.method, path: req.originalUrl.split('?')[0], status };
  if (error === UNEXPECTED) log.error('request failed', { ...where, err: errMsg(err), stack: err instanceof Error ? err.stack : undefined });
  else if (status >= 500) log.error('request failed', { ...where, err: errMsg(err) });
  else log.debug('request refused', { ...where, err: errMsg(err) });
  if (res.headersSent) { next(err); return; }   // mid-stream: Express ends the connection
  res.status(status).json(code ? { error, code } : { error });
}

/** Mounted on /api after the router: a path no route serves is a JSON 404, not Express's HTML page. */
export function apiNotFound(req: Request, res: Response): void {
  log.debug('no such api path', { method: req.method, path: req.originalUrl.split('?')[0] });
  res.status(404).json({ error: 'Kino could not find that. Reload the page to get the latest version.' });
}
