import express, { type Router } from 'express';
import { logger } from '../log.js';
import { httpError, safeKey } from '../errors.js';
import * as torrent from '../torrent.js';
import type { DecodeCaps } from '../score.js';
import type { MediaType, Target } from '../types.js';

export const log = logger('http');

/**
 * A router for one part of the API. Async handlers need no wrapper: Express 5 hands a rejected promise to the
 * error handler (jsonErrors). Every :videoId names a progress key (and its first part a meta id key), checked here.
 */
export function apiRouter(): Router {
  const r = express.Router();
  r.param('videoId', (_req, _res, next, v: unknown) => { try { safeKey(v, 'video id'); next(); } catch (e) { next(e); } });
  return r;
}

export const mt = (s: string): MediaType => (s === 'series' ? 'series' : 'movie');
export const target = (s: unknown): Target => (s === 'ios' || s === 'chromecast' ? s : 'browser');
/** What a browser says it decodes besides H.264 (?hevc=1&av1=1), for the ranking; undefined when it names nothing. */
export function decodeCaps(q: Record<string, unknown>): DecodeCaps | undefined {
  const c: DecodeCaps = {};
  if (q.hevc === '1') c.hevc = true;
  if (q.av1 === '1') c.av1 = true;
  return c.hevc || c.av1 ? c : undefined;
}
/** An optional request value that becomes a state key (credits, intros): absent is fine, `__proto__` and friends are a 400. */
export const optKey = (v: unknown, what: string): string | undefined => (v === undefined || v === null || v === '' ? undefined : safeKey(v, what));
/** A whole number from 0 up, as a request body sends a file or stream index. A numeric string is not one. */
export const wholeIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** A finite number, as a request body sends a millisecond offset. A numeric string is not one. */
export const finiteMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/**
 * A hash Kino chose (torrent.isKnown, the /api/file rule), or a 404. For GETs that would load a torrent: they sit
 * behind the PIN, but a cross-site <img> still reaches them, and ensure() would join that torrent's swarm.
 * `waitMs` covers the player asking for subtitles in the same breath as its POST /api/play: it answers the moment
 * the play starts loading the hash, and only an unknown one waits it out.
 */
export async function knownHash(h: string, waitMs = 0): Promise<string> {
  if (!(await torrent.whenKnown(h, waitMs))) throw httpError(404, 'Kino has not loaded that torrent');
  return h;
}

/** How long GET /api/subs waits for the POST /api/play it raced. A `let` so tests can shorten the 404 wait. */
export let playRaceMs = 2000;
/** Tests only. */
export function setPlayRaceMsForTests(ms: number): void { playRaceMs = ms; }
