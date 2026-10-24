import type { MediaType, Source, Target } from './types.js';
import { GB } from './config.js';

const RES: Record<string, number> = { '2160p': 70, '1080p': 100, '720p': 60, '480p': 20, other: 30 };

/**
 * The automatic pick, in the owner's words: as good a picture as possible, and it must not stop to buffer. A longer
 * wait before the first frame is fine. So a release first has to stream: its swarm must deliver the file comfortably
 * within its running time plus a prefetch. Among those that do, quality decides. When none does, the one closest to
 * streaming wins. Every number here is a parameter, tuned on the owner's own picks with scripts/pick-agreement.ts.
 */
export interface PickParams {
  /** Bytes a second a very large swarm delivers: a handful of fast peers and the home line set this ceiling. */
  maxRate: number;
  /** Live seeders at which a swarm gives half of maxRate. Each extra seeder adds less than the one before. */
  halfSeeds: number;
  /** An addon's own seeder figure, when the trackers did not answer, counts this much of a live count: it is stale. */
  addonTrust: number;
  /** What a placeholder count (the same number on every release of a provider) stands for. */
  placeholderSeeds: number;
  /** Seconds of prefetch before play starts. */
  bufferSec: number;
  /** Streamable: the swarm can deliver the file this many times over in runtime plus buffer. */
  margin: number;
  /** Points per doubling of headroom above the margin, up to headroomCap times the margin. */
  headroomPts: number;
  headroomCap: number;
  /** Points lost per halving of headroom below the margin. Steep: a release that stops is the worst outcome. */
  shortPts: number;
  /** Points per doubling of bitrate against what looks good at that resolution, counted up to qualityCap doublings either way. */
  qualityPts: number;
  qualityCap: number;
}

/**
 * halfSeeds, margin, headroomPts and qualityPts were tuned on 44 of the owner's picks (2026-10-01): he follows big
 * swarms, so headroom keeps paying well past "streams fine". The rest are set by reasoning. With these, a 45 minute
 * episode of 3 GB wants about 90 live seeders, of 1 GB about 30, a 2 GB film about 25, a 20 GB one 350; a 60 GB remux never streams.
 */
export const PICK: PickParams = {
  maxRate: 12 * 1024 ** 2, halfSeeds: 400, addonTrust: 0.5, placeholderSeeds: 20, bufferSec: 75,
  margin: 2, headroomPts: 10, headroomCap: 16, shortPts: 40, qualityPts: 2, qualityCap: 2,
};

/** A typical running time, when the metadata has none. */
export const RUNTIME_SEC: Record<MediaType, number> = { movie: 110 * 60, series: 45 * 60 };
/** H.264 megabits a second that look good at each resolution. HEVC and AV1 get there with 1/EFFICIENT of it. */
const GOOD_MBPS: Record<string, number> = { '2160p': 16, '1080p': 6, '720p': 3, '480p': 1.5, other: 1.5 };
const EFFICIENT = 1.6;
const lean = (s: Source) => s.codec === 'hevc' || s.codec === 'av1';

/** Seeders worth counting: a live count as is, an addon's figure discounted, a placeholder as a modest swarm. */
export function effectiveSeeds(s: Source, p: PickParams = PICK): number {
  if (s.seedersEstimated) return Math.min(p.placeholderSeeds, s.seeders ?? 0);
  return s.seedersLive ? s.seeders ?? 0 : (s.seeders ?? 0) * p.addonTrust;
}

/** Bytes a second a swarm of that many seeders delivers: rises with seeders, levels off at maxRate. */
export function swarmRate(seeds: number, p: PickParams = PICK): number { return seeds > 0 ? p.maxRate * seeds / (seeds + p.halfSeeds) : 0; }

/** The file's size, or what a release of its resolution typically weighs over that runtime. */
const sizeOf = (s: Source, runtimeSec: number) => s.sizeBytes || (GOOD_MBPS[s.resolution || 'other'] * 1e6 / 8) * runtimeSec;

/**
 * How many times over the swarm can deliver the file within its running time plus the prefetch: 1 is just in time,
 * 0 means nobody seeds it. Big files with few seeders score low, lean ones with many seeders high.
 */
export function headroom(s: Source, runtimeSec: number, p: PickParams = PICK): number {
  return (swarmRate(effectiveSeeds(s, p), p) * (runtimeSec + p.bufferSec)) / sizeOf(s, runtimeSec);
}

/** Bitrate against what looks good at the release's resolution, in doublings (0 is just right). 0 without a size. */
export function bitrateDoublings(s: Source, runtimeSec: number): number {
  if (!s.sizeBytes) return 0;
  const mbps = ((s.sizeBytes * 8) / runtimeSec / 1e6) * (lean(s) ? EFFICIENT : 1);
  return Math.log2(mbps / GOOD_MBPS[s.resolution || 'other']);
}

/**
 * A release name for a whole season or more, not one episode: "S02", "S02 Complete", "S01-S03", "Season 2", "Complete Series".
 * The season token must stand alone, so "S02E03", "S02.E03" and the "S5" inside "DTS5.1" do not count.
 */
const SEASON_PACK = /\bS\d{1,2}\b(?![ .-]?E\d)|\bseasons?[ .-]?\d{1,2}\b(?![ .-]?(?:E|Ep|Episode)[ .-]?\d)|\bcomplete[ .-]series\b/i;
export function isSeasonPack(name: string): boolean { return SEASON_PACK.test(name.replace(/_/g, ' ')); }

/**
 * Codecs besides H.264 a browser says it decodes (client/lib/player-caps.ts), so they play or copy as is (media/decide.ts).
 * `hdr`: the screen shows HDR itself, so nothing is tone-mapped. No browser: decide.ts tone-maps every HDR file there. A
 * DLNA TV, ranked as a browser, pulls the raw file (cast/dlna.ts DECODES).
 */
export interface DecodeCaps { hevc?: boolean; av1?: boolean; hdr?: boolean }
/** What the streams route knows besides the sources: the title's running time from its metadata, and what the browser decodes. */
export interface PickContext { runtimeSec?: number; caps?: DecodeCaps }
export const runtimeFor = (kind: MediaType | undefined, ctx: PickContext = {}): number => ctx.runtimeSec || RUNTIME_SEC[kind || 'series'];

const clamp = (x: number, cap: number) => Math.max(-cap, Math.min(cap, x));
/**
 * Why the browser transcodes this release's video, as media/decide.ts decides, or undefined when it plays or copies it
 * as is: HEVC or AV1 it does not decode, or HDR, tone-mapped whatever the codec unless the screen shows HDR (caps.hdr).
 */
function browserTranscode(s: Source, caps: DecodeCaps = {}): string | undefined {
  if ((s.codec === 'hevc' && !caps.hevc) || (s.codec === 'av1' && !caps.av1)) return `${s.codec.toUpperCase()}: transcodes in browser`;
  if (s.hdr && !caps.hdr) return `${s.hdr}: tone-mapped`;
  return undefined;
}

/**
 * Score a source for a playback target. Higher is better, above 0 is worth playing. Mutates warnings, headroom and score.
 * `kind` is what was asked for, when known: a movie is never a season pack, whatever its title says ("Open.Season.2").
 */
export function scoreSource(s: Source, target: Target, kind?: MediaType, ctx: PickContext = {}, p: PickParams = PICK): number {
  const w: string[] = [];
  const runtime = runtimeFor(kind, ctx);
  let sc = RES[s.resolution || 'other'];
  if (s.sourceTag === 'CAM' || s.sourceTag === 'TS') { sc = -1000; w.push('Camrip / telesync'); }
  if (s.sourceTag === 'REMUX') { sc += 5; if ((s.sizeBytes || 0) > 25 * GB) sc -= 40; }
  else if (s.sourceTag === 'BluRay') sc += 15;
  else if (s.sourceTag === 'WEB-DL') sc += 18;
  else if (s.sourceTag === 'WEBRip' || s.sourceTag === 'WEB') sc += 10;
  else if (s.sourceTag === 'HDTV') sc += 2;

  // Will it stream? Below the margin every halving costs a lot; above it, extra headroom is a small bonus.
  const room = headroom(s, runtime, p);
  s.headroom = Math.round(room * 100) / 100;
  if (!effectiveSeeds(s, p)) w.push('No seeders reported');
  else if (room < p.margin) w.push('Few seeders for its size: may stop to buffer');
  sc += room >= p.margin ? p.headroomPts * Math.log2(Math.min(room / p.margin, p.headroomCap)) : -p.shortPts * Math.log2(p.margin / Math.max(room, p.margin / 32));
  // Quality within a resolution: more bits look better, up to a point; a tiny file for its resolution looks worse.
  sc += p.qualityPts * clamp(bitrateDoublings(s, runtime), p.qualityCap);

  if (lean(s)) {
    if (target === 'chromecast') { sc -= 70; w.push(`${s.codec!.toUpperCase()}: will transcode for Chromecast`); }
    else if (target === 'ios') { sc -= 25; w.push(`${s.codec!.toUpperCase()}: may transcode`); }
  }
  // A browser plays or copies what it decodes; one transcode costs little (hardware encode on the Apple Silicon Mac).
  if (target === 'browser') { const why = browserTranscode(s, ctx.caps); if (why) { sc -= 6; w.push(why); } }
  if (s.hdr && (target === 'chromecast' || target === 'ios')) { sc -= 30; w.push(`${s.hdr}: tone-mapped`); }
  if (s.resolution === '2160p' && target !== 'browser') { sc -= 20; }
  if (s.resolution === '2160p' && lean(s) && target === 'chromecast') { sc -= 100; w.push(`4K ${s.codec!.toUpperCase()}: too heavy to transcode`); }

  // Language: a dub is useless for an English show; dual audio works but the default track is a gamble.
  if (s.foreignAudio === 'dub') { sc -= 90; w.push(`${(s.langs || []).join('/').toUpperCase()} dub, not English`); }
  else if (s.foreignAudio === 'dual') { sc -= 30; w.push(`Dual audio (${(s.langs || []).join('/').toUpperCase()} + EN): check the audio track`); }
  if (s.audio && /DTS|TrueHD|Atmos/.test(s.audio) && target === 'chromecast') { sc -= 5; w.push('HD audio: re-encoded to AAC'); }
  if (kind !== 'movie' && s.fileIdx == null && !s.filename && isSeasonPack(s.releaseName)) { sc -= 30; w.push('Season pack without file index'); }

  s.warnings = w;
  s.score = Math.round(sc);
  return s.score;
}

export function rankSources(sources: Source[], target: Target, kind?: MediaType, ctx: PickContext = {}, p: PickParams = PICK): Source[] {
  for (const s of sources) scoreSource(s, target, kind, ctx, p);
  return [...sources].sort((a, b) => b.score - a.score || (b.seeders || 0) - (a.seeders || 0));
}

export function pickAuto(ranked: Source[], preferBinge?: string): Source | undefined {
  const ok = ranked.filter((s) => s.score > 0);
  if (!ok.length) return ranked[0];
  if (preferBinge) {
    const same = ok.find((s) => s.bingeGroup === preferBinge);
    if (same && same.score >= ok[0].score - 25) return same;
  }
  return ok[0];
}
