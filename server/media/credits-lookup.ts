import { logger, errMsg } from '../log.js';
import { getState, update } from '../store.js';
import * as torrent from '../torrent.js';
import { probe } from './probe.js';
import { localFileUrl } from './range.js';
import { listSubtitles, getVtt } from '../subs/index.js';
import { parseVtt } from '../subs/srt2vtt.js';
import { estimateCredits, type CreditsEstimate } from './credits.js';
import { estimateIntro, anchorFor, dialogue, pushIntro, type IntroEstimate, type IntroSample } from './intro.js';

const log = logger('credits');

/**
 * The dialogue of one file, in seconds, from the subtitle Kino would pick for you. Empty when there is none.
 * An OpenSubtitles fetch the first time, the subtitle cache after that.
 */
async function subtitleLines(t: Awaited<ReturnType<typeof torrent.ensure>>, videoId: string | undefined, fileIdx: number): Promise<{ start: number; end: number; text: string }[]> {
  if (!videoId || videoId.startsWith('magnet:')) return [];
  try {
    const tracks = await listSubtitles('series', videoId, t, fileIdx);
    const pref = getState().settings.subLangs[0];
    const track = tracks.find((x) => x.available && x.lang === pref && x.recommended) || tracks.find((x) => x.available && x.recommended) || tracks.find((x) => x.available);
    if (!track) return [];
    return parseVtt(await getVtt(track.id, 0, torrent.getTorrent)).map((c) => ({ start: c.start / 1000, end: c.end / 1000, text: c.text }));
  } catch (e) { log.debug('subtitles unavailable', { err: errMsg(e) }); return []; }
}

/**
 * Where the credits start for one file: learned presses for the show, chapters, or the last subtitle line.
 * The subtitle read is the slow part (an OpenSubtitles fetch), so callers ask once playback is running.
 * Shared by the browser player (GET /api/credits) and the cast up-next engine.
 */
export async function creditsFor(p: { infoHash: string; fileIdx: number; videoId?: string; metaId?: string }): Promise<CreditsEstimate> {
  const t = torrent.getTorrent(p.infoHash) || (await torrent.ensure(p.infoHash));
  const info = await probe(`${t.infoHash}:${p.fileIdx}`, localFileUrl(t.infoHash, p.fileIdx));
  const lines = await subtitleLines(t, p.videoId, p.fileIdx);
  const lastCueEndSec = lines.length ? Math.max(...lines.map((c) => c.end)) : undefined;
  return estimateCredits({ duration: info.duration, chapters: info.chapters, lastCueEndSec, learnedOffsets: p.metaId ? getState().credits[p.metaId] : undefined });
}

/** Where the opening titles sit in this file: a chapter, or a window you skipped in an earlier episode found again. */
export async function introFor(p: { infoHash: string; fileIdx: number; videoId?: string; metaId?: string }): Promise<IntroEstimate> {
  const t = torrent.getTorrent(p.infoHash) || (await torrent.ensure(p.infoHash));
  const info = await probe(`${t.infoHash}:${p.fileIdx}`, localFileUrl(t.infoHash, p.fileIdx));
  const samples = p.metaId ? getState().intros[p.metaId] : undefined;
  const lines = samples?.some((s) => s.anchor != null) ? await subtitleLines(t, p.videoId, p.fileIdx) : undefined;
  return estimateIntro({ duration: info.duration, chapters: info.chapters, lines, samples });
}

/** Remember a skip over the titles, with how long after it the dialogue came back, for the next episodes. */
export async function learnIntro(p: { infoHash?: string; fileIdx?: number; videoId?: string; metaId: string; start: number; end: number }): Promise<IntroSample[]> {
  let anchor: number | undefined;
  if (p.infoHash && p.fileIdx != null) {
    const t = torrent.getTorrent(p.infoHash) || (await torrent.ensure(p.infoHash));
    anchor = anchorFor(dialogue(await subtitleLines(t, p.videoId, p.fileIdx)), p.end);
  }
  update((s) => { s.intros[p.metaId] = pushIntro(s.intros[p.metaId], { start: p.start, end: p.end, anchor }); });
  return getState().intros[p.metaId];
}
