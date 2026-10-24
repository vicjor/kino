import { logger, errMsg } from '../log.js';
import { stopOnShutdown } from '../lifecycle.js';
import { getState } from '../store.js';
import { meta as getMeta, nextEpisode, parseVideoId } from '../meta.js';
import { creditsFor } from '../media/credits-lookup.js';
import { episodeCode } from '../episode-name.js';
import type { CastStatus, Episode, Settings, UpNext } from '../types.js';

const log = logger('cast.upnext');

/**
 * Netflix-style "Up next" for a cast session. Once a second it looks at what is casting; when a series
 * episode reaches its credits (estimated like the browser player does) it publishes an UpNext on the
 * cast status so every phone shows the popup, and, with auto-next on, counts down and plays the next
 * episode on the same device. "Not now" turns into "stop after this episode": the FINISHED fallback in
 * the manager asks `stopAfter()` before queueing anything.
 *
 * The manager wires it up (`start`) so this module never imports the manager: `onShow`/`onHide` let the
 * Chromecast draw the same countdown on the TV as a text track.
 */
export interface Deps {
  status: () => CastStatus; castNext: (manual: boolean) => Promise<unknown>; publish: () => void; onShow?: () => void; onHide?: () => void;
  /** Auto-next settings. The stored ones unless a test passes its own. */
  settings?: () => Pick<Settings, 'autoNext' | 'autoNextDelaySec'>;
  /** The next episode and where the credits start. Cinemeta plus the credits lookup unless a test passes its own. */
  plan?: (s: CastStatus, alive: () => boolean) => Promise<Plan | undefined>;
}

/** What `prepare` learns about the episode on screen. */
export interface Plan { next: Episode; show?: string; poster?: string; creditsAt?: number; confidence: UpNext['confidence'] }

interface Track {
  videoId: string; loading: boolean;
  next?: Episode; show?: string; poster?: string;
  creditsAt?: number; confidence: UpNext['confidence'];
  shown: boolean; dismissed: boolean; startsAt?: number; fired: boolean;
  /** When the previous tick ran (epoch ms): a paused countdown moves its end on by the real time since. */
  lastTick?: number;
}

let deps: Deps | null = null;
let cur: Track | null = null;
let stopAfterId: string | null = null;
const FALLBACK_BEFORE_END = 30;
/** Longest countdown that starts in the last 30 s: it ends before the episode does. */
const FALLBACK_COUNTDOWN = 20;

/**
 * Seconds to count down from position `pos`, or undefined for no countdown yet. A high or medium credits
 * estimate counts down from the credits; a low one or none only in the last 30 s, capped at 20 s.
 */
export function countdownSec(confidence: UpNext['confidence'], pos: number, dur: number, delaySec: number): number | undefined {
  const sure = confidence === 'high' || confidence === 'medium';
  if (!sure && pos < dur - FALLBACK_BEFORE_END) return undefined;
  return Math.max(3, sure ? delaySec : Math.min(delaySec, FALLBACK_COUNTDOWN));
}

let timer: NodeJS.Timeout | null = null;
/** Wire the engine and run it once a second. Idempotent: a second start only takes the new wiring, it never adds a timer. */
export function start(d: Deps): void {
  deps = d;
  if (timer) return;
  timer = setInterval(() => {
    const wired = deps; if (!wired) return;
    try { tick(Date.now(), wired); } catch (e) { log.warn('tick failed', { err: errMsg(e) }); }
  }, 1000);
  timer.unref();
  stopOnShutdown('upnext', stop);
}
/** Stop the once-a-second engine (the shutdown runs it). The wiring stays, so status and cancel still answer. */
export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests only: forget the episode and the stop-after flag, and take `d` as the wiring without a timer. */
export function _reset(d: Deps | null = null): void { deps = d; cur = null; stopAfterId = null; }

/** What the status carries: the popup while it is up, and the stop-after flag for this episode. */
export function decorate(s: CastStatus): CastStatus {
  if (!s.active) return s;
  const out: CastStatus = { ...s };
  if (s.videoId && stopAfterId === s.videoId) out.stopAfter = true;
  if (cur && cur.shown && !cur.dismissed && cur.next && cur.videoId === s.videoId) {
    out.upNext = { episode: cur.next, videoId: cur.next.id, show: cur.show || '', poster: cur.poster, startsAt: cur.startsAt, confidence: cur.confidence };
  }
  return out;
}

export function current(): UpNext | undefined { return deps ? decorate(deps.status()).upNext : undefined; }
export function stopAfter(videoId: string | undefined): boolean { return !!videoId && stopAfterId === videoId; }

/** "Not now" on the popup, or "Stop after this episode" in the controller. Idempotent. */
export function cancel(): void {
  const s = deps?.status();
  if (!s?.active || !s.videoId) return;
  stopAfterId = s.videoId;
  if (cur && cur.videoId === s.videoId && cur.shown && !cur.dismissed) { cur.dismissed = true; cur.startsAt = undefined; deps?.onHide?.(); }
  deps?.publish();
}
/** Undo `cancel`: auto-next is back on for this episode, and the popup returns if the credits are running. */
export function resume(): void {
  stopAfterId = null;
  if (cur?.dismissed) { cur.dismissed = false; cur.shown = false; }
  deps?.publish();
}

function reset(d: Deps): void {
  if (cur?.shown && !cur.dismissed) d.onHide?.();
  cur = null;
}

/** One step of the engine, once a second in production. `now` is epoch ms. */
export function tick(now: number, d: Deps): void {
  const s = d.status();
  if (!s.active || !s.videoId || s.type !== 'series' || s.videoId.startsWith('magnet:')) { if (cur) reset(d); if (!s.active) stopAfterId = null; return; }
  if (!cur || cur.videoId !== s.videoId) {
    reset(d);
    const t: Track = { videoId: s.videoId, loading: true, confidence: 'none', shown: false, dismissed: false, fired: false };
    cur = t;
    void prepare(t, s, d.plan ?? plan);
    return;
  }
  const t = cur;
  const elapsed = Math.max(0, now - (t.lastTick ?? now)); t.lastTick = now;
  if (t.loading || !t.next || !s.duration) return;
  const pos = s.currentTime || 0; const dur = s.duration;
  const at = t.creditsAt != null && t.confidence !== 'none' ? t.creditsAt : dur - FALLBACK_BEFORE_END;
  const onScreen = s.state !== 'IDLE' && s.state !== 'BUFFERING';
  /** Start the countdown when the settings and the estimate allow one at this position. */
  const count = (): boolean => {
    const settings = (d.settings ?? (() => getState().settings))();
    const sec = settings.autoNext && stopAfterId !== s.videoId ? countdownSec(t.confidence, pos, dur, settings.autoNextDelaySec) : undefined;
    if (sec != null) t.startsAt = now + sec * 1000;
    return sec != null;
  };
  // Rewound well before the credits: take the popup down again, it will come back.
  if (t.shown && !t.fired && pos < at - 8) { t.shown = false; t.dismissed = false; t.startsAt = undefined; d.onHide?.(); d.publish(); return; }
  if (!t.shown && onScreen && pos >= at) {
    t.shown = true;
    count();
    log.info('up next', { after: s.videoId, next: t.next.id, at: Math.round(at), confidence: t.confidence, auto: !!t.startsAt });
    d.publish();
    if (!t.dismissed) d.onShow?.();
    return;
  }
  // A low estimate put the popup up without a countdown: start one in the last 30 s, like the fallback.
  if (t.shown && !t.dismissed && !t.startsAt && !t.fired && onScreen) {
    if (count()) { log.info('up next countdown', { after: s.videoId, pos: Math.round(pos) }); d.publish(); }
    return;
  }
  if (t.shown && t.startsAt && !t.fired) {
    // The countdown waits while the TV is paused or buffering, by the time that really passed.
    if (s.state !== 'PLAYING') { t.startsAt += elapsed; return; }
    if (now >= t.startsAt) {
      t.fired = true;
      d.castNext(false).catch((e) => { log.warn('auto-next failed', { err: errMsg(e) }); if (cur === t) { t.startsAt = undefined; d.publish(); } });
    }
  }
}

async function prepare(t: Track, s: CastStatus, find: NonNullable<Deps['plan']>): Promise<void> {
  try {
    const p = await find(s, () => cur === t);
    if (p && cur === t) Object.assign(t, p);
  } catch (e) { log.warn('prepare failed', { err: errMsg(e) }); }
  finally { if (cur === t) t.loading = false; }
}

/** Production plan: the next episode from Cinemeta, then the credits estimate when the file is known. */
async function plan(s: CastStatus, alive: () => boolean): Promise<Plan | undefined> {
  const videoId = s.videoId!;
  const { metaId } = parseVideoId(videoId);
  const m = await getMeta('series', metaId);
  const next = nextEpisode(m, videoId);
  if (!next || !alive()) return undefined;
  const p: Plan = { next, show: m.name, poster: m.poster, confidence: 'none' };
  if (s.infoHash && s.fileIdx != null && s.fileIdx >= 0) {
    try {
      const c = await creditsFor({ infoHash: s.infoHash, fileIdx: s.fileIdx, videoId, metaId });
      p.creditsAt = c.at; p.confidence = c.confidence;
    } catch (e) { log.debug('credits estimate failed', { err: errMsg(e) }); }
  }
  return p;
}

/** The countdown as WebVTT cue blocks on the receiver's own timeline (seconds), for the TV overlay. */
export function countdownCues(u: UpNext | undefined, receiverTime: number, now = Date.now()): string[] {
  if (!u) return [];
  const label = `Up next: ${episodeCode(u.episode.season, u.episode.episode)}${u.episode.title ? ` ${u.episode.title}` : ''}`;
  const settings = 'line:8% position:96% align:end size:48%';
  const ts = (sec: number) => { sec = Math.max(0, sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
  const blocks: string[] = [];
  if (u.startsAt) {
    const left = Math.max(1, Math.ceil((u.startsAt - now) / 1000));
    for (let i = 0; i < left; i++) blocks.push(`${ts(receiverTime + i)} --> ${ts(receiverTime + i + 1)} ${settings}\n${label}\nPlaying in ${left - i} s`);
    blocks.push(`${ts(receiverTime + left)} --> ${ts(receiverTime + left + 8)} ${settings}\n${label}\nStarting…`);
  } else {
    blocks.push(`${ts(receiverTime)} --> ${ts(receiverTime + 20)} ${settings}\n${label}\nPress Next in Kino to play it`);
  }
  return blocks;
}
