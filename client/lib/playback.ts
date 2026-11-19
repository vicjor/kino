import type { PlayResponse, Source, SubtitleTrack } from '../../server/types.js';

/** The pure decisions behind the player (client/screens/Player.tsx and its hooks), and the words it shares with the TV's remote. */

/** "Switching to <provider> 1080p": what a source switch says, in the player and on the TV's remote. */
export const switchWords = (s: Pick<Source, 'provider' | 'addon' | 'resolution'>): string =>
  `Switching to ${s.provider || s.addon}${s.resolution && s.resolution !== 'other' ? ` ${s.resolution}` : ''}`;

/** No source to go on with: "No good source found for the next episode", "No sources for that episode". */
export const noEpisodeSourceWords = (anySources: boolean, next = false): string =>
  `No ${anySources ? 'good source found' : 'sources'} for ${next ? 'the next' : 'that'} episode`;

/** How the file reaches this screen, for the line under the title: plain words first, the codec for the curious. */
export function playHow(play: PlayResponse | null): string | undefined {
  if (!play) return undefined;
  const how = play.mode === 'direct' ? 'Direct' : play.mode === 'hls-copy' ? 'Remuxed' : 'Transcoded';
  const v = play.probe?.video;
  return `${how}${v ? ` · ${v.codec.toUpperCase()}${v.height ? ` ${v.height}p` : ''}` : ''}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** The next playback speed up (1) or down (-1) the ladder from `rate`, held at both ends. */
export function speedStep(rate: number, dir: 1 | -1): number {
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.findIndex((x) => x >= rate - 0.01) + dir))];
}
export const speedWords = (rate: number): string => (rate === 1 ? 'Normal speed' : `${rate}×`);

/** A seek target held inside the file: never before the start, never past a second before the end. */
export const clampSeek = (t: number, dur: number): number => Math.max(0, Math.min(t, dur ? dur - 1 : t));

/** A big jump backwards (a stray tap on the seek bar): worth a mark where you were. */
export const bigJumpBack = (from: number, to: number): boolean => from > 90 && from - to > 60;

export interface Mark { t: number; label: string }
/** The marks on the seek bar with `m` added: one per half minute, the newest three. */
export const withMark = (ms: Mark[], m: Mark): Mark[] => [...ms.filter((x) => Math.abs(x.t - m.t) > 30), m].slice(-3);

interface Ranges { readonly length: number; start(i: number): number; end(i: number): number }
/** Media time ranges (buffered, seekable) as pairs, shifted onto the file's timeline by `offset`. */
export function rangePairs(r: Ranges, offset: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < r.length; i++) out.push([r.start(i) + offset, r.end(i) + offset]);
  return out;
}
/** Whether `t` falls inside any of the ranges. */
export function inRanges(r: Ranges, t: number): boolean {
  for (let i = 0; i < r.length; i++) if (t >= r.start(i) && t <= r.end(i)) return true;
  return false;
}

/** Where the up-next popup comes up: at the credits when the estimate is worth anything, else 30 s before the end (0 without a duration). */
export function nextPopupAt(credits: { at?: number; confidence: string } | null, dur: number): number {
  return credits?.at != null && credits.confidence !== 'none' ? credits.at : dur ? dur - 30 : 0;
}

/** The up-next countdown: whether it runs over the credits, and whether it plays on by itself at zero. */
export function upNextMode(o: { ended: boolean; credits: { at?: number; confidence: string } | null; autoNext: boolean; sleepEpisode: boolean }): { credits: boolean; auto: boolean } {
  const c = o.credits;
  return {
    credits: !o.ended && !!c?.at && c.confidence !== 'none',
    auto: o.autoNext && !o.sleepEpisode && (o.ended || (!!c?.at && (c.confidence === 'high' || c.confidence === 'medium'))),
  };
}

export interface Tap { t: number; x: number }
/** A second tap within 350 ms near the first, on the left or right third (x runs 0 to 1 across): skip 10 s back or on. */
export function doubleTapSkip(prev: Tap, now: Tap): -10 | 10 | null {
  if (now.t - prev.t < 350 && Math.abs(prev.x - now.x) < 0.15 && (now.x < 0.34 || now.x > 0.66)) return now.x < 0.34 ? -10 : 10;
  return null;
}

/** The track picked for a language: the recommended one, then a hash match, then the first one there. */
export function bestInLang(tracks: SubtitleTrack[], lang: string): SubtitleTrack | undefined {
  const inLang = tracks.filter((x) => x.available && x.lang === lang);
  return inLang.find((x) => x.recommended) || inLang.find((x) => x.hashMatch) || inLang[0];
}

/** What the subtitles key turns on: the track used last, else the first English one, else any. */
export function subToTurnOn(tracks: SubtitleTrack[], last: SubtitleTrack | null): SubtitleTrack | undefined {
  return (last && tracks.find((x) => x.id === last.id && x.available)) || tracks.find((x) => x.available && /^en/.test(x.lang || '')) || tracks.find((x) => x.available);
}

/** How long to wait while buffering before the stall sheet opens, or null when it should not wait at all. */
export function stallWaitMs(o: { ready: boolean; err: boolean; open: boolean; buffering: boolean; snoozedUntil: number; now: number; hasPlay: boolean }): number | null {
  if (!o.ready || o.err || o.open || !o.buffering || o.now < o.snoozedUntil) return null;
  return o.hasPlay ? 18_000 : 35_000;
}
