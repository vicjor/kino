import type { ErrorCode, PlayResponse, TorrentStats } from '../../server/types.js';
import { fmtBytes, fmtSpeed, fmtTime } from './format';

/*
 * The player's failure and stall copy, in plain words: no ffmpeg, transcoder, peers or seeders. A failure from the
 * server is told apart by its `code` (server ErrorCode), never by matching the server's text, which only ever shows
 * as the detail under the words.
 */

/** What went wrong, and what to do about it. */
export interface Words { msg: string; hint?: string }

const BY_CODE: Record<ErrorCode, Words> = {
  'no-peers': { msg: 'Could not fetch this file', hint: 'Nobody is sharing this source right now. Pick one that more people share.' },
  'unreadable': { msg: 'Could not fetch this file', hint: 'Too little of it arrives to start playing. Pick a source that more people share.' },
  'disk-full': { msg: 'Not enough disk space', hint: 'Clear the cache in Settings, or free some space on the Mac running Kino.' },
  'tool-broken': { msg: 'Kino cannot play videos right now', hint: 'A program Kino needs does not run on its Mac. Settings says how to fix it.' },
  'transcode-failed': { msg: 'Kino could not convert this video for this screen', hint: 'Trying again picks up from where you were. If it keeps failing, another source of the same title usually works.' },
  'session-gone': { msg: 'Kino stopped this stream', hint: 'Trying again picks up from where you were.' },
};

/** Codes where trying again by itself cannot help: a full disk or a program that does not run stays that way. */
const STUCK: ReadonlySet<string> = new Set<ErrorCode>(['disk-full', 'tool-broken']);
/** Whether the player may quietly try again (it does twice, after a server restart for instance). Not for a full disk or a broken program. */
export const autoRetry = (code: string | undefined): boolean => !code || !STUCK.has(code);

/** The words for a server code. Undefined for no code, and for one this page does not know yet (a newer server). */
export const codeWords = (code: string | undefined): Words | undefined => (code && Object.hasOwn(BY_CODE, code) ? BY_CODE[code as ErrorCode] : undefined);

/** Why playback could not start. Without a known code, a plain line. */
export const startWords = (code: string | undefined): Words => codeWords(code) ?? { msg: 'Could not start playback' };

/** The conversion stopped partway through (hls.state): a full disk or a broken ffmpeg says so, anything else is the same story. */
export const stoppedWords = (code: string | undefined): Words =>
  (code === 'transcode-failed' ? undefined : codeWords(code)) ?? { msg: 'Kino stopped converting this video', hint: 'Trying again starts it again from where you were. If it keeps failing, pick another source.' };

/** One line for a toast when an action fails (a seek, another audio track): the code's words, else the server's own. */
export function toastWords(code: string | undefined, fallback: string): string {
  const w = codeWords(code);
  return w ? (w.hint ? `${w.msg}. ${w.hint}` : w.msg) : fallback;
}

/** "3 people sharing it". */
export const sharing = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'} sharing it`;
/** The download line under the player: "3 people sharing it", or nobody. */
export const sharingNow = (n: number): string => (n > 0 ? sharing(n) : 'Nobody sharing it');

/**
 * The browser's own failures while it plays (client/lib/hls-attach.ts, the Player). No server code to go by here:
 * the media element or hls.js said what broke.
 */
export const MEDIA = {
  /** hls.js itself did not arrive. */
  loader: { msg: 'The player could not load', hint: 'Kino stopped answering while the page was loading a part of the player. Check that the Mac is awake, then try again.' },
  /** The stream stopped answering. */
  lost: { msg: 'Lost contact with Kino', hint: 'Check that the Mac running Kino is awake and on the network, then try again.' },
  /** The stream is gone on the Mac's side (404 or 410). */
  gone: { msg: 'Kino stopped this stream', hint: 'The Mac running Kino ended it, most likely after a long pause. Trying again picks up from where you were.' },
  /** The browser could not make sense of the video it got. */
  broken: { msg: 'This video does not play in this browser', hint: 'Part of the file may be damaged, or it uses a format this browser does not play. Another source, or casting to the TV, usually works.' },
  /** The browser does not play this kind of file at all. */
  format: { msg: 'This format cannot be played here', hint: 'Try casting to the TV or pick another source.' },
  /** No HLS here at all, neither hls.js nor the browser's own. */
  browser: { msg: 'This browser cannot play this stream', hint: 'Safari, Chrome or Firefox all work. Casting to the TV works from any of them.' },
  /** Anything else hls.js gives up on. */
  other: { msg: 'Playback failed' },
} satisfies Record<string, Words>;

/** "ended" well before the end: the download ran dry (direct play) or the conversion stopped. */
export function endedEarlyWords(direct: boolean): Words {
  return {
    msg: 'The stream ended early',
    hint: direct ? 'The download could not keep up with playback. Wait a moment and try again, or switch to a source more people share.' : 'Converting the video most likely stopped. Trying again starts it again from where you were.',
  };
}
export function endedEarlyDetail(at: number, dur: number, st: Pick<TorrentStats, 'numPeers' | 'downloadSpeed'> | null): string {
  return `Stopped at ${fmtTime(at)} of ${fmtTime(dur)}${st ? ` · ${sharing(st.numPeers)} · ${fmtSpeed(st.downloadSpeed)}` : ''}`;
}

type Stats = Pick<TorrentStats, 'numPeers' | 'downloadSpeed'> | null;
type Playing = Pick<PlayResponse, 'mode' | 'sizeBytes'> & { probe?: { duration?: number } };

/** The line under the spinner while the video loads or waits. */
export function waitWords(loading: boolean, play: Playing | null, stats: Stats): string {
  if (loading) return stats ? (stats.numPeers ? `Connecting to ${sharing(stats.numPeers)}…` : 'Looking for people sharing it…') : 'Starting…';
  if (!play) return 'Looking for people sharing it…';
  return stats && stats.numPeers === 0 ? 'Waiting for someone to share it…' : 'Buffering';
}

/** Why playback has been stuck for a while (the stall sheet), and the way out. */
export function stallWords(play: Playing | null, stats: Stats): { reason: string; hint?: string } {
  const peers = stats?.numPeers ?? 0; const speed = stats?.downloadSpeed ?? 0;
  const size = play?.sizeBytes || 0; const d = play?.probe?.duration || 0;
  const need = size && d ? size / d : 0;
  if (!play && !stats) return { reason: 'Still looking for people sharing this file. Nobody seems to have it right now.', hint: 'A source nobody shares never starts. One that more people share will.' };
  if (peers === 0) return { reason: 'Nobody is sharing this file right now.', hint: 'Another source of the same title usually is. Or download this one for later and let it arrive overnight.' };
  if (need && speed < need * 0.9) return { reason: `Getting ${fmtSpeed(speed)} from ${sharing(peers)}, but this ${fmtBytes(size)} file needs about ${fmtSpeed(need)} to play smoothly.`, hint: size > 6 * 1024 ** 3 ? 'It is a big file. A smaller source of the same title streams far easier, or download this one for later.' : 'Too few people are sharing this one right now.' };
  if (play?.mode === 'hls-transcode') return { reason: 'The download is fine, but converting the video for this screen cannot keep up.', hint: 'A source in a more common video format plays without converting.' };
  return { reason: 'The download looks fine, but playback keeps stopping.', hint: 'The file may be damaged or the network flaky. Another source is the quickest fix.' };
}

/** The nudge after a few stops to load in a row: the chip's text, and what the source list opens with. */
export function stutterWords(series: boolean): { text: string; reason: string } {
  return { text: 'This stream keeps stuttering', reason: `This source keeps stopping to load. These others are for the same ${series ? 'episode' : 'film'}.` };
}

/** The nudge when the download falls behind the video while it plays: the chip's text, and what the source list opens with. */
export function slowWords(peers: number, speed: number, need: number): { text: string; reason: string } {
  return peers === 0
    ? { text: 'Nobody is sharing this source', reason: 'Nobody is sharing this source right now.' }
    : { text: 'Download slower than the video', reason: `Only ${fmtSpeed(speed)} from ${sharing(peers)}; this file needs about ${fmtSpeed(need)}.` };
}
