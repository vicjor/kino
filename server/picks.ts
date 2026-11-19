import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { logger, errMsg } from './log.js';
import type { DecodeCaps } from './score.js';
import type { MediaType, PickOutcome, Source, Target } from './types.js';

const log = logger('picks');

/**
 * A local log of the sources the owner plays from a source list, so the automatic pick can be checked and tuned
 * against his own choices later (scripts/pick-agreement.ts report --picks). The streams route remembers each answer
 * for a while under a short key. When a release from that list is played or cast, the client posts the key and the
 * release, and one line goes to picks.jsonl: when, the title, the target (and the codecs a browser decodes), Auto's
 * pick, the chosen one and every candidate's features. Kino's own picks (the title's Play button, a TV's auto-next)
 * write the same line, `via` saying who chose. It stays on this Mac and holds no addon URLs or tokens; link-like
 * text is cut out of release names. The file never grows past MAX_BYTES: the oldest lines go first.
 *
 * Then what happened to it: when the player on this screen runs into trouble with a release picked here (the stall
 * sheet, a download slower than the video, a switch to another source, a stop for nobody sharing it, a file that ran
 * dry), an outcome line follows, tied to its pick by `pickT` (the pick line's `t`) and `chosen`. Ids and numbers only.
 * One line per kind per pick, and only for a pick logged in the last OUTCOME_HOURS. Pick lines from `v: 2` on can have
 * outcomes; older ones never do. Which picks are that recent is read back from the log itself, so a restart keeps it.
 */
export const PICKS_FILE = path.join(DATA_DIR, 'picks.jsonl');
export const MAX_BYTES = 4 * 1024 ** 2;
/** Streams answers remembered at once; candidates logged per pick (the best ranked, plus the chosen one). */
const KEEP = 40;
const MAX_CANDIDATES = 40;
/** The pick line format: 2 since outcomes came in. */
const VERSION = 2;
/** How long after a pick the player's trouble still counts as the pick's outcome. */
export const OUTCOME_HOURS = 12;

export interface Offer { videoId: string; type: MediaType; target: Target; caps?: DecodeCaps; runtimeSec?: number; auto?: string; sources: Source[] }
const offers = new Map<string, Offer>();

/**
 * The newest remembered answer for a video that lists the release: a page showing an older answer for it (from the
 * client's cache, or from before a restart) still logs its pick against the ranking the server made since.
 */
function latestFor(videoId: string, chosen: string): Offer | undefined {
  return [...offers.values()].reverse().find((o) => o.videoId === videoId && o.sources.some((s) => s.id === chosen));
}

/** Remember a ranked streams answer; the key goes to the client with it. */
export function remember(o: Offer): string {
  const key = crypto.randomBytes(6).toString('hex');
  offers.set(key, o);
  while (offers.size > KEEP) offers.delete(offers.keys().next().value!);
  return key;
}

/** A release name without links or a bracketed site tag ("[site.to]", "[ Site.me ]"): the parsed features already say what the name did. */
export function scrub(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, '').replace(/\bwww\.\S+/gi, '').replace(/\[[^\]]*\.[a-z]{2,3}(?:\s[^\]]*)?\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}

const FEATURES = ['id', 'infoHash', 'fileIdx', 'provider', 'releaseName', 'filename', 'seeders', 'seedersEstimated', 'seedersLive', 'seedersAddon', 'sizeBytes', 'resolution', 'codec', 'hdr', 'audio', 'sourceTag', 'langs', 'foreignAudio'] as const;
/** What the scorer reads from a source, and nothing else. */
export function features(s: Source): Partial<Source> {
  const out: Record<string, unknown> = {};
  for (const k of FEATURES) if (s[k] !== undefined) out[k] = k === 'releaseName' || k === 'filename' ? scrub(String(s[k])) : s[k];
  return out as Partial<Source>;
}

/**
 * Who picked and how: `play` and `cast` from a source list (the owner's choice), `auto` the title's Play button taking
 * Auto's pick, `auto-next` a TV's own pick of the next episode (cast/manager.ts). Only the owner's choices measure the
 * automatic pick; the rest learn outcomes.
 */
export type Via = 'play' | 'cast' | 'auto' | 'auto-next';
/** The line for a pick from a remembered answer, or undefined when the key or the release is unknown. */
export function pickLine(o: Offer, chosen: string, via: Via, now = Date.now()): string | undefined {
  const pick = o.sources.find((s) => s.id === chosen);
  if (!pick) return undefined;
  const list = o.sources.slice(0, MAX_CANDIDATES);
  if (!list.includes(pick)) list.push(pick);
  return JSON.stringify({ t: now, v: VERSION, videoId: o.videoId, type: o.type, target: o.target, caps: o.caps, via, runtimeSec: o.runtimeSec, auto: o.auto, chosen, sources: list.map(features) });
}

const OUTCOMES: Record<PickOutcome, true> = { stall: true, slow: true, switch: true, 'no-peers': true, unreadable: true, 'ended-early': true };
export const isOutcome = (v: unknown): v is PickOutcome => typeof v === 'string' && Object.hasOwn(OUTCOMES, v);

/** What the player says happened: where in the video (`pos`) and after how many seconds of watching, both in seconds. */
export interface OutcomeReport { videoId: string; chosen: string; outcome: PickOutcome; pos?: number; watchedSec?: number }
const secs = (n: number | undefined) => (n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
/** The line for an outcome of the pick logged at `pickT`. */
export function outcomeLine(pickT: number, r: OutcomeReport, now = Date.now()): string {
  return JSON.stringify({ t: now, outcome: r.outcome, videoId: r.videoId, chosen: r.chosen, pickT, pos: secs(r.pos), watchedSec: secs(r.watchedSec) });
}

/** Keep the newest lines that fit in half of max: called once the file outgrows max. */
export function trimLines(text: string, max = MAX_BYTES): string {
  const lines = text.split('\n').filter(Boolean);
  let bytes = 0, i = lines.length;
  while (i > 0 && bytes + Buffer.byteLength(lines[i - 1]) + 1 <= max / 2) bytes += Buffer.byteLength(lines[--i]) + 1;
  return lines.slice(i).map((l) => `${l}\n`).join('');
}

/** One line onto the log, trimmed once it outgrows MAX_BYTES. */
function append(line: string, file: string): boolean {
  try {
    fs.appendFileSync(file, `${line}\n`);
    if (fs.statSync(file).size > MAX_BYTES) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, trimLines(fs.readFileSync(file, 'utf8')));
      fs.renameSync(tmp, file);
    }
    return true;
  } catch (e) { log.warn('could not log pick', { err: errMsg(e) }); return false; }
}

/** Picks logged lately, by video and release: when, and the outcomes already logged for it. KEEP at most. */
const logged = new Map<string, { t: number; seen: Set<PickOutcome> }>();
const pickId = (videoId: string, chosen: string) => `${videoId}|${chosen}`;
function link(videoId: string, chosen: string, t: number): void {
  const id = pickId(videoId, chosen);
  logged.delete(id); logged.set(id, { t, seen: new Set() });
  while (logged.size > KEEP) logged.delete(logged.keys().next().value!);
}

/**
 * The links between picks and outcomes, read back from the log the first time it is used (after a restart): every
 * pick of the last OUTCOME_HOURS and the outcomes already logged for it. The log is the store, so nothing else is kept.
 */
let linkedFile: string | undefined;
function linkFrom(file: string, now: number): void {
  if (linkedFile === file) return;
  linkedFile = file; logged.clear();
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }   // no log yet
  for (const l of text.split('\n')) {
    if (!l) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
    if (typeof o.videoId !== 'string' || typeof o.chosen !== 'string') continue;
    if (Array.isArray(o.sources) && typeof o.t === 'number' && now - o.t <= OUTCOME_HOURS * 3600_000) link(o.videoId, o.chosen, o.t);
    else if (isOutcome(o.outcome)) { const p = logged.get(pickId(o.videoId, o.chosen)); if (p && p.t === o.pickT) p.seen.add(o.outcome); }
  }
}
/** Tests only: forget the links, as a restart does. */
export function forgetLinksForTests(): void { linkedFile = undefined; logged.clear(); }

/**
 * Log one pick from the source list. When Kino no longer remembers that list (`key`), the newest answer for `videoId`
 * that lists the release stands in. False when neither is known or the release is not on it.
 */
export function record(key: string, chosen: string, via: Via, file = PICKS_FILE, now = Date.now(), videoId?: string): boolean {
  const o = offers.get(key) ?? (videoId ? latestFor(videoId, chosen) : undefined);
  return !!o && logPick(o, chosen, via, file, now);
}

/** Log a pick Kino made from a ranking it holds (auto-next): the same line a list pick writes. */
export function logPick(o: Offer, chosen: string, via: Via, file = PICKS_FILE, now = Date.now()): boolean {
  const line = pickLine(o, chosen, via, now);
  if (!line) return false;
  linkFrom(file, now);
  if (!append(line, file)) return false;
  link(o.videoId, chosen, now);
  return true;
}

/**
 * Log what happened to a release picked lately. False when no pick of it was logged in the last OUTCOME_HOURS (it was
 * played from a link or Continue watching), or this outcome is in already.
 */
export function recordOutcome(r: OutcomeReport, file = PICKS_FILE, now = Date.now()): boolean {
  linkFrom(file, now);
  const pick = logged.get(pickId(r.videoId, r.chosen));
  if (!pick || now - pick.t > OUTCOME_HOURS * 3600_000 || pick.seen.has(r.outcome)) return false;
  pick.seen.add(r.outcome);
  return append(outcomeLine(pick.t, r, now), file);
}
