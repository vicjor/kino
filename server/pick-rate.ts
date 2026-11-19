import * as torrent from './torrent.js';
import * as picks from './picks.js';
import { logger, errMsg } from './log.js';
import type { RateSample } from './picks.js';

const log = logger('pick-rate');

/** What one look at a torrent's file says: metadata in, bytes of the file on disk, its size, peers now. */
export interface Look { ready: boolean; downloaded: number; length: number; numPeers: number }
export interface RateOpts {
  /** How long to measure, once the torrent has its metadata. */
  windowMs: number;
  /** How long to wait for the metadata (the player or the TV asks for the file a moment after the pick). */
  waitMs: number;
  /** How often to look while waiting. */
  tickMs: number;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** Torrents loaded at the end: more than one shares the line. */
  torrents: () => number;
}
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref(); });
const RATE: RateOpts = { windowMs: 60_000, waitMs: 3 * 60_000, tickMs: 2000, wait: sleep, now: Date.now, torrents: torrent.activeTorrents };
/** A file this far along was mostly on disk already: its download says nothing about the swarm. */
const MOSTLY_THERE = 0.98;

/**
 * How fast a picked file downloads over the first minute after its torrent has the metadata: bytes of the file gained
 * between two looks. Undefined when the metadata never came, the file was on disk already, or the torrent went away.
 * Only measures; never changes what plays.
 */
export async function sampleRate(look: () => Look | undefined, o: RateOpts = RATE): Promise<RateSample | undefined> {
  const asked = o.now();
  let a = look();
  while (!a?.ready) {
    if (o.now() - asked >= o.waitMs) return undefined;
    await o.wait(o.tickMs);
    a = look();
  }
  if (a.length > 0 && a.downloaded >= a.length * MOSTLY_THERE) return undefined;
  const t0 = o.now();
  await o.wait(o.windowMs);
  const b = look();
  if (!b?.ready) return undefined;
  return { bytes: Math.max(0, b.downloaded - a.downloaded), sec: (o.now() - t0) / 1000, peers: b.numPeers, haveAtStart: a.downloaded, length: b.length, torrents: o.torrents() };
}

/** Measure a pick just logged ("hash:fileIdx", a file index below 0 for the torrent's video) and log its rate. */
function measure(videoId: string, chosen: string): void {
  const [infoHash, i] = chosen.split(':');
  const idx = Number(i) >= 0 ? Number(i) : undefined;
  sampleRate(() => torrent.stats(infoHash, idx))
    .then((s) => { if (s) picks.recordRate(videoId, chosen, s); })
    .catch((e: unknown) => log.debug('rate not measured', { err: errMsg(e) }));
}

/** Every pick logged from now on gets its first minute's download rate in the pick log. */
export function start(): void { picks.onPicked(measure); }
