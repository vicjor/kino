import { logger, errMsg } from './log.js';
import { applyLiveSeeds } from './parse.js';
import { scrapeSeeds } from './scrape.js';
import { rankSources, pickAuto, type DecodeCaps } from './score.js';
import type { MediaType, Source, Target } from './types.js';

const log = logger('rank');

/** The longest a ranking waits on the trackers. scrape.ts gives up on a slow tracker sooner; this holds whatever it does. */
const SEEDS_WAIT_MS = 4000;

export interface RankContext {
  /** The title's running time (meta.runtimeOf, or runtimeSeconds of a meta already at hand). */
  runtimeSec?: number;
  /** Prefer this binge group when it scores close to the top. */
  binge?: string;
  /** Codecs the browser decodes besides H.264: the browser target charges them no transcode. */
  caps?: DecodeCaps;
  /** Tests only: a shorter cap on the tracker wait. */
  seedsWaitMs?: number;
}

/**
 * The one way Kino ranks a title's sources: the source list (the streams route) and the pick a TV makes on its own
 * (auto-next and Next) both come here, so they cannot drift. Seeders counted on the trackers replace the addons'
 * stale or placeholder figures, the running time tells the pick what bitrate a file needs, and the kind asked for
 * decides what a season pack is. Updates the seeder figures in `sources`. The trackers get seedsWaitMs at most:
 * past that, or when they fail, the addons' figures stand.
 */
export async function rankLive(sources: Source[], target: Target, kind: MediaType, ctx: RankContext = {}): Promise<{ ranked: Source[]; auto?: Source }> {
  applyLiveSeeds(sources, await liveSeeds(sources.map((s) => s.infoHash), ctx.seedsWaitMs ?? SEEDS_WAIT_MS));
  const ranked = rankSources(sources, target, kind, { runtimeSec: ctx.runtimeSec, caps: ctx.caps });
  return { ranked, auto: pickAuto(ranked, ctx.binge) };
}

/** Live counts from the trackers, or what is known by waitMs. Never rejects. */
async function liveSeeds(hashes: string[], waitMs: number): Promise<Map<string, number>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Map<string, number>>((r) => { timer = setTimeout(() => { log.debug('trackers too slow: the addons\' figures stand', { waitMs }); r(new Map()); }, waitMs); });
  const asked = scrapeSeeds(hashes).catch((e: unknown) => { log.debug('scrape failed', { err: errMsg(e) }); return new Map<string, number>(); });
  try { return await Promise.race([asked, late]); }
  finally { clearTimeout(timer); }
}
