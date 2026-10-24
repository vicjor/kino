import { PORT, lanIp } from '../config.js';
import { logger, errMsg } from '../log.js';
import { httpError, statusOf, ownStatus, codeOf } from '../errors.js';
import { emit } from '../events.js';
import { getState, saveProgress, getProgress, update, saveSubChoice, MIN_PROGRESS_SEC } from '../store.js';
import { ensure, pickVideoFile, getTorrent } from '../torrent.js';
import { guard } from '../disk.js';
import { probe } from '../media/probe.js';
import { decide, pickAudio } from '../media/decide.js';
import * as hls from '../media/hls.js';
import { mimeFor } from '../media/range.js';
import { listSubtitles, getVtt } from '../subs/index.js';
import { pushLearned } from '../media/credits.js';
import * as upnext from './upnext.js';
import { meta as getMeta, nextEpisode, parseVideoId, runtimeSeconds } from '../meta.js';
import { episodeName } from '../episode-name.js';
import { getStreams } from '../addons.js';
import { rankLive } from '../rank.js';
import { haEvent } from '../ha.js';
import * as discovery from './discovery.js';
import * as dlna from './dlna.js';
import { CastSession, plainCastError, noAnswer, unreachable, type RawStatus } from './session.js';
import type { CastPlayRequest, CastStatus, SubtitleTrack, PlayMode, Target } from '../types.js';
import type { DecodeCaps } from '../score.js';
import { shouldNudge } from './keepawake.js';

const log = logger('cast');

interface Current {
  device: { id: string; name: string; host: string; port: number };
  session: CastSession;
  req: CastPlayRequest;
  infoHash: string; fileIdx: number; mode: PlayMode; hlsId?: string; startOffset: number; duration: number;
  tracks: { trackId: number; sub: SubtitleTrack }[]; activeSubId?: string; subOffsetMs: number;
  raw?: RawStatus; rawAt: number; lastSave: number; finished: boolean; loading: boolean;
  /** When the pause began and the last keep-awake seek (keepawake.ts). A nudge passes through BUFFERING, which keeps the pause. */
  pausedAt?: number; nudgedAt?: number;
  /** Synthetic "Up next" text track: the TV fetches /api/cast/upnext/<token>.vtt when we activate it at the credits. */
  upnextToken?: string; upnextTrackId?: number;
  /** The subtitle lookup this cast got, for its restarts. Unset when the lookup failed. */
  subs?: KnownSubs;
}
/** A subtitle list and the file it was looked up for. `done`: the file was complete then (embedded tracks count only once it is). */
interface KnownSubs { infoHash: string; fileIdx: number; done: boolean; list: SubtitleTrack[] }
/** `subs`: the list of the cast a seek or subtitle shift restarts, so the same file needs no new lookup (file hash, addon calls). */
type CastOpts = { preferLang?: string; subs?: KnownSubs };

/** What a start reaches outside this module. Tests swap these for fakes. */
export const io = {
  device: (id: string) => discovery.get(id),
  /** Whether dlna.ts knows this renderer: found over SSDP, or remembered while it is off (casting wakes it). Read only. */
  renderer: (id: string): boolean => dlna.knows(id),
  /** The torrent's video file and what ffprobe says about it. */
  media: async (id: string, fileIdx: number) => {
    const t = await ensure(id);
    const idx = pickVideoFile(t, fileIdx >= 0 ? fileIdx : undefined);
    if (idx < 0) throw httpError(400, 'No video file in this torrent');
    const local = `http://127.0.0.1:${PORT}/api/file/${t.infoHash}/${idx}`;
    return { t, idx, local, probe: await probe(`${t.infoHash}:${idx}`, local) };
  },
  subtitles: listSubtitles,
  connect: async (host: string, port: number): Promise<CastSession> => { const s = new CastSession(host, port); await s.connect(); return s; },
  hls: { start: hls.start, waitReady: hls.waitReady, stop: hls.stop, revive: hls.revive },
  /** What auto-next and Next ask the network: the series and the sources of an episode. */
  meta: getMeta,
  streams: getStreams,
};

let cur: Current | null = null;
let lastStatus: CastStatus = { active: false };

// ------------------------------------------------------------- ordering ----
// castTo and stop each take the next generation. A start checks it after every await and gives
// up once a newer command has begun, cleaning up only what it made itself, so the newest command wins:
// a burst of seek presses ends in one load at the last time, a stop pressed during a start stops it, and
// up-next racing a manual Next casts the next episode once.
let castGen = 0;
/** Aborted as castGen moves on: hands a DLNA start the cancellation, so a wake called off stops at once. */
let cancel = new AbortController();
function nextGen(): number { cancel.abort(); cancel = new AbortController(); return ++castGen; }
/** The TV the newest command wants, null after a stop. A start that lost leaves the receiver app up only there. */
let target: string | null = null;
/**
 * The newest start still working. A cast it is about to replace ignores its own idle reports meanwhile.
 * `restart` marks a seek or subtitle shift of what is casting: the status reports its time, and the next
 * seek builds on it, so repeated presses add up.
 */
let pending: { gen: number; deviceId: string; req?: CastPlayRequest; opts?: CastOpts; restart?: boolean } | null = null;

function begin(deviceId: string, more: { req?: CastPlayRequest; opts?: CastOpts; restart?: boolean } = {}): number {
  const gen = nextGen(); target = deviceId; pending = { gen, deviceId, ...more };
  return gen;
}
function settle(gen: number): void { if (pending?.gen === gen) pending = null; }
/** A start is over without taking the TV. If it was the newest, the cast it meant to replace plays on (its ffmpeg may have been parked for it). */
function ended(gen: number): void {
  if (pending?.gen !== gen) return;
  pending = null;
  if (cur?.hlsId) io.hls.revive(cur.hlsId);
  publish();
}
/** A start that failed after a newer command began: nobody is waiting for its error. */
function lost(gen: number, e: unknown): CastStatus {
  if (gen === castGen) throw plain('cast', e);
  log.info('a start that lost failed', { err: errMsg(e) });
  return status();
}
/** A TV that never answered, or whose app refused the command, reaches the phone in plain words; the detail goes to the log. */
function plain(what: string, e: unknown): unknown {
  const out = plainCastError(e);
  if (out !== e) log.warn(`${what}: ${statusOf(out) === 504 ? 'no answer from the TV' : 'the TV refused'}`, { err: errMsg(e) });
  return out;
}
async function tv(what: string, fn: () => Promise<void>): Promise<void> { try { await fn(); } catch (e) { throw plain(what, e); } }

/**
 * A DLNA error as the phone should read it: a TV that never answered or cannot be reached in plain words (the detail
 * goes to the log). dlna.ts throws its own errors with their status and words (httpError): those pass as they are,
 * a refusal's UPnP detail to the log. Anything else is a surprise, for jsonErrors' generic sentence.
 */
function plainDlnaError(e: unknown): unknown {
  const m = errMsg(e);
  if (ownStatus(e) !== undefined) { const detail = (e as { detail?: unknown }).detail; if (detail) log.warn('dlna: the TV refused', { err: m, detail }); return e; }
  if ((e as Error | null)?.name === 'TimeoutError' || m.includes('aborted due to timeout')) { log.warn('dlna: no answer from the TV', { err: m }); return noAnswer(); }
  if (e instanceof TypeError && m === 'fetch failed') { log.warn('dlna: TV unreachable', { err: errMsg(e.cause) }); return unreachable(); }
  return e;
}
/** One call into dlna.ts, its error made plain (plainDlnaError). Every awaited DLNA command goes through this. */
export async function viaDlna<T>(fn: () => Promise<T>): Promise<T> { try { return await fn(); } catch (e) { throw plainDlnaError(e); } }
function replacing(c: Current): boolean { return !!pending && pending.deviceId === c.device.id; }
function restartOf(c: Current): CastPlayRequest | undefined { return pending?.restart && pending.deviceId === c.device.id ? pending.req : undefined; }
/** What start `gen` was asked, with the subtitle picked since if it is a restart (setSubtitle records it on `pending`). */
function asked(gen: number, req: CastPlayRequest): CastPlayRequest { return pending?.gen === gen && pending.req ? pending.req : req; }

function base(): string { return `http://${lanIp()}:${PORT}`; }

/** Kino's own session, whichever transport carries it, plus the up-next popup state. */
export function status(): CastStatus { return upnext.decorate(dlna.active() ? dlna.status() : lastStatus); }

function publish(): void {
  if (!cur) { lastStatus = { active: false }; emit('cast.status', status()); return; }
  const r = cur.raw;
  const to = restartOf(cur)?.startTime;   // a seek still starting: say where it goes
  lastStatus = {
    active: true, deviceId: cur.device.id, deviceName: cur.device.name,
    state: cur.loading || to != null ? 'BUFFERING' : r?.state || 'BUFFERING',
    currentTime: to ?? (r?.currentTime || 0) + cur.startOffset, duration: cur.duration || r?.duration,
    volume: r?.volume, muted: r?.muted, activeSubId: cur.activeSubId, videoId: cur.req.videoId, title: cur.req.title, poster: cur.req.poster,
    infoHash: cur.infoHash, fileIdx: cur.fileIdx, mode: cur.mode, timeOffset: cur.startOffset, subOffsetMs: cur.subOffsetMs, type: cur.req.videoId?.includes(':') && !cur.req.videoId.startsWith('magnet:') ? 'series' : 'movie', subs: cur.tracks.map((t) => t.sub),
  };
  emit('cast.status', status());
}

function onStatus(c: Current, s: RawStatus): void {
  if (cur !== c) return;
  const prev = c.raw; c.raw = s; c.rawAt = Date.now();
  if (prev?.state !== s.state) {
    if (s.state === 'PLAYING') haEvent('play', { title: c.req.title, target: c.device.name });
    else if (s.state === 'PAUSED') haEvent('pause', { title: c.req.title, target: c.device.name });
  }
  // While it loads, or while a newer start for this TV is on its way, an idle receiver ends nothing: the next load replaces it.
  const settled = !c.loading && !replacing(c);
  if (s.state === 'IDLE' && s.idleReason === 'FINISHED' && !c.finished && settled) { c.finished = true; void onFinished(c); }
  else if (s.state === 'IDLE' && (s.idleReason === 'CANCELLED' || s.idleReason === 'ERROR') && settled) { log.info('receiver idle', { reason: s.idleReason }); void teardown(c, false); return; }
  if (s.state === 'PAUSED') c.pausedAt ??= Date.now();
  else if (s.state !== 'BUFFERING') c.pausedAt = c.nudgedAt = undefined;
  if (s.state === 'PAUSED' && settled && shouldNudge(c.pausedAt!, c.nudgedAt || 0, Date.now())) {
    c.nudgedAt = Date.now();
    log.info('paused: keeping the receiver awake', { pausedMin: Math.round((Date.now() - c.pausedAt!) / 60_000) });
    c.session.seek(s.currentTime).catch((e) => log.warn('keep-awake seek failed', { err: errMsg(e) }));
  }
  // Not while loading: a direct-play receiver reports 0 until it has seeked to the start time, and 0 must never overwrite where you were.
  if (c.req.videoId && !c.loading && s.state !== 'IDLE' && Date.now() - c.lastSave > 10_000) { c.lastSave = Date.now(); persist(c, s.currentTime + c.startOffset); }
  publish();
}

function persist(c: Current, pos: number): void {
  if (!c.req.videoId || !(pos >= MIN_PROGRESS_SEC)) return;   // a refused load or a receiver still at 0 is not a position
  const { metaId, season, episode } = parseVideoId(c.req.videoId);
  const existing = getProgress(c.req.videoId);
  saveProgress({ videoId: c.req.videoId, metaId, type: season != null ? 'series' : 'movie', pos, dur: c.duration || existing?.dur || 0, updatedAt: Date.now(), name: c.req.title, poster: c.req.poster || existing?.poster, background: existing?.background, season, episode, infoHash: c.infoHash, fileIdx: c.fileIdx });
}

async function onFinished(c: Current): Promise<void> {
  log.info('finished', { videoId: c.req.videoId });
  if (c.req.videoId) persist(c, c.duration || c.raw?.currentTime || 0);
  haEvent('stop', { title: c.req.title, target: c.device.name, reason: 'finished' });
  // A start for another TV is on its way (one waking takes up to 90 s): it takes over, so no next episode here.
  const ok = !pending && await autoNext(c.req.videoId, c.device.id, c.activeSubId ? c.tracks.find((t) => t.sub.id === c.activeSubId)?.sub.lang : undefined, c.subOffsetMs);
  if (!ok && cur === c && !replacing(c)) await teardown(c, false);
}

/**
 * How a TV's own pick ranks sources (score.ts). The old Chromecast as itself; a DLNA TV pulls the raw file and decodes it
 * itself, so as a browser that shows HEVC and HDR as they are (dlna.DECODES).
 */
function rankAs(deviceId: string): { target: Target; caps?: DecodeCaps } {
  return dlna.isDlnaId(deviceId) ? { target: 'browser', caps: dlna.DECODES } : { target: 'chromecast' };
}

/**
 * Moving on to the next episode means this one was watched. Up next starts at the credits, so the last saved position
 * is short of the end (and of the 95 % that counts as finished): without this the episode was never checked off. A
 * record with no duration gets the "marked as watched" shape (pos 1 of dur 1).
 */
export function markWatched(videoId: string): void {
  const p = getProgress(videoId);
  if (!p) return;
  saveProgress(p.dur > 0 ? { ...p, pos: p.dur } : { ...p, pos: 1, dur: 1 });
}

/**
 * Queue the next episode on the same device. Shared by Chromecast and DLNA sessions. True once handled,
 * also when another command (a stop, a seek, the other of two Next presses) came first and won. False when
 * there is nothing to play; a failure is logged and false too, unless `force` (Next) wants it thrown.
 */
async function autoNext(videoId: string | undefined, deviceId: string, subLang: string | undefined, subOffsetMs: number, force = false): Promise<boolean> {
  const { metaId, season } = parseVideoId(videoId || '');
  if (!videoId || season == null || (!force && (!getState().settings.autoNext || upnext.stopAfter(videoId)))) return false;
  const gen = castGen;
  const gone = () => { if (gen === castGen) return false; log.info('auto-next: a newer command won', { after: videoId }); return true; };
  try {
    const m = await io.meta('series', metaId);
    if (gone()) return true;
    const next = nextEpisode(m, videoId);
    if (!next) return false;
    const { sources } = await io.streams('series', next.id);
    if (gone()) return true;
    // Ranked as the source list ranks it: live seeders, and the show's running time from the meta just fetched.
    const { target: tg, caps } = rankAs(deviceId);
    const { auto: pick } = await rankLive(sources, tg, 'series', { runtimeSec: runtimeSeconds(m.runtime), caps });
    if (gone()) return true;
    if (!pick || pick.score <= 0) return false;
    log.info('auto-next', { next: next.id, source: pick.releaseName, device: deviceId });
    await castTo({ deviceId, infoHash: pick.infoHash, fileIdx: pick.fileIdx ?? -1, videoId: next.id, title: episodeName(m.name, next.season, next.episode, next.title), poster: m.poster, startTime: 0, subId: undefined, subOffsetMs }, subLang ? { preferLang: subLang } : {});
    // After the switch: ending the old session saved where it was (the credits), and this must win over that.
    markWatched(videoId);
    return true;
  } catch (e) { if (force) throw e; log.warn('auto-next failed', { err: errMsg(e) }); return false; }
}

/**
 * Skip to the next episode on the device that is casting now. Throws when there is none to play, or with
 * the reason when it could not be cast.
 * A deliberate press in the last twenty minutes teaches where this show's credits start, like the browser player.
 */
export async function castNext(manual = true): Promise<CastStatus> {
  const s = status();
  if (!s.active || !s.deviceId || !s.videoId) throw httpError(409, 'Nothing is casting');
  if (manual && s.duration && s.currentTime != null) {
    const left = s.duration - s.currentTime; const { metaId } = parseVideoId(s.videoId);
    if (left > 10 && left < 20 * 60 && !metaId.startsWith('magnet:')) update((st) => { st.credits[metaId] = pushLearned(st.credits[metaId], left); });
  }
  const c = cur;
  const subLang = c?.activeSubId ? c.tracks.find((t) => t.sub.id === c.activeSubId)?.sub.lang : undefined;
  const ok = await autoNext(s.videoId, s.deviceId, subLang, s.subOffsetMs || 0, true);
  if (!ok) throw httpError(404, 'No next episode with a playable source');
  return status();
}

/** Another release of what is casting, same device, same position, same subtitle language. */
export async function switchSource(infoHash: string, fileIdx: number | undefined): Promise<CastStatus> {
  const s = status();
  if (!s.active || !s.deviceId || !s.title) throw httpError(409, 'Nothing is casting');
  const subLang = s.activeSubId ? s.subs?.find((t) => t.id === s.activeSubId)?.lang : undefined;
  const req: CastPlayRequest = { deviceId: s.deviceId, infoHash, fileIdx: fileIdx ?? -1, videoId: s.videoId, title: s.title, poster: s.poster, startTime: Math.max(0, s.currentTime || 0), subOffsetMs: s.subOffsetMs };
  log.info('switch source', { from: s.infoHash, to: infoHash, at: req.startTime });
  return castTo(req, subLang ? { preferLang: subLang } : {});
}

export function castTo(req: CastPlayRequest, opts: CastOpts = {}): Promise<CastStatus> { return run(req, opts, false); }

const castGone = () => httpError(404, 'TV or speaker not found. Refresh the device list.');
const dlnaGone = () => httpError(404, 'TV not found. Is it on and connected to this Wi-Fi?');
/** A start for a TV Kino does not know is a 404 before it begins: it ends no cast, nor a start still working (a seek restarting). */
function mustKnow(deviceId: string): void {
  if (dlna.isDlnaId(deviceId)) { if (!io.renderer(deviceId)) throw dlnaGone(); }
  else if (!io.device(deviceId)) throw castGone();
}

async function run(req: CastPlayRequest, opts: CastOpts, restart: boolean): Promise<CastStatus> {
  mustKnow(req.deviceId);
  const gen = begin(req.deviceId, dlna.isDlnaId(req.deviceId) ? {} : { req, opts, restart });
  const signal = cancel.signal;
  if (restart) publish();
  try { return await start(gen, signal, req, opts); }
  catch (e) { return lost(gen, e); }
  finally { ended(gen); }
}

async function start(gen: number, signal: AbortSignal, req: CastPlayRequest, opts: CastOpts): Promise<CastStatus> {
  const gone = () => gen !== castGen;
  if (dlna.isDlnaId(req.deviceId)) {
    // dlna.ts checks the signal after each await too: a TV that takes 90 s to wake never takes over from a newer command.
    // What plays on a Chromecast plays on until the TV answers: a wake that fails leaves it playing.
    await viaDlna(() => dlna.castTo(req, { preferLang: opts.preferLang, signal, takeOver: endCast }));
    return status();
  }
  if (dlna.active()) { await dlna.stop(false); if (gone()) return status(); }
  const dev = io.device(req.deviceId);
  if (!dev) throw castGone();
  guard();
  const { t, idx, local, probe: p } = await io.media(req.infoHash, req.fileIdx);
  if (gone()) return status();
  const audioIndex = pickAudio(p, req.audioTrack, ['eng', ...getState().settings.subLangs]);
  const d = decide(p, 'chromecast', { hdr: p.hdr, audioIndex });
  const type = req.videoId?.includes(':') && !req.videoId.startsWith('magnet:') ? 'series' : 'movie';
  const done = (t.files[idx]?.progress ?? 0) >= 1;
  let known = opts.subs && opts.subs.infoHash === t.infoHash && opts.subs.fileIdx === idx && opts.subs.done === done ? opts.subs : undefined;
  if (!known) try { known = { infoHash: t.infoHash, fileIdx: idx, done, list: (await io.subtitles(type, req.videoId, t, idx)).filter((s) => s.available).slice(0, 30) }; } catch (e) { log.warn('subs failed', { err: errMsg(e) }); }
  if (gone()) return status();
  const subs = known?.list ?? [];

  // Same device: reuse the connection, and keep what it plays until the new stream is ready.
  const old = cur;
  const reuse = !!old && old.device.id === dev.id;
  let session: CastSession;
  if (old && reuse) session = old.session;
  else {
    if (old) await teardown(old, false);
    if (gone()) return status();
    session = await io.connect(dev.host, dev.port);
    if (gone()) { await dropFresh(session, dev.id); return status(); }
  }

  let startOffset = d.mode === 'direct' ? 0 : Math.max(0, Math.floor(req.startTime || 0));
  let url: string; let contentType: string; let hlsId: string | undefined;
  if (d.mode === 'direct') { url = `${base()}/api/file/${t.infoHash}/${idx}`; contentType = mimeFor(t.files[idx].name); }
  else {
    // The old cast's ffmpeg is parked here when it is the same file (the TV plays on from what it made), stopped otherwise.
    const s = io.hls.start({ infoHash: t.infoHash, fileIdx: idx, sourceUrl: local, startOffset, decision: d, probe: p, owner: 'cast' });
    hlsId = s.id; url = `${base()}/api/hls/${s.id}/index.m3u8`; contentType = 'application/vnd.apple.mpegurl';
    // Wait for the first segment: fail here with a real error instead of on the
    // TV, and learn the measured start (copy mode begins at the previous keyframe)
    // so subtitle timing and the reported position are exact.
    try { await io.hls.waitReady(s, 40_000); }
    catch (e) {
      io.hls.stop(s.id);
      if (gone()) { if (!reuse) await dropFresh(session, dev.id); return status(); }
      // Nothing owns a connection made just for this cast yet: close it and take the receiver app off the TV.
      if (old && reuse) await keepOrEnd(old); else await discard(session);
      const st = statusOf(e);   // ffmpeg on this Mac: its own 5xx (503 still starting), else 500
      // Its code too (transcode-failed, tool-broken, disk-full): the phone words a failure by it, as the player does.
      throw httpError(st >= 500 ? st : 500, `Could not start the stream: ${errMsg(e)}`, codeOf(e));
    }
    await s.measured?.catch(() => undefined);
    if (gone()) { io.hls.stop(s.id); if (!reuse) await dropFresh(session, dev.id); return status(); }
    startOffset = s.startOffset;
  }
  const tracks = subs.map((sub, i) => ({ trackId: i + 1, sub }));
  const subId = asked(gen, req).subId;   // a subtitle picked while this restart waited for its stream counts
  // Nothing asked for: the subtitle remembered for this video (null there means you turned them off).
  const saved = subId === undefined && req.videoId ? getProgress(req.videoId) : undefined;
  const subOffsetMs = req.subOffsetMs ?? saved?.subOffsetMs ?? 0;
  let activeSubId = subId && tracks.some((x) => x.sub.id === subId) ? subId : undefined;
  if (!activeSubId && saved?.subId && tracks.some((x) => x.sub.id === saved.subId)) activeSubId = saved.subId;
  if (!activeSubId && opts.preferLang && saved?.subId !== null) activeSubId = tracks.find((x) => x.sub.lang === opts.preferLang)?.sub.id;
  // The saved track is gone, or only its language was saved: the first track in it (the list puts its recommended one
  // first), as the browser picks. Saved as off (null) stays off.
  if (!activeSubId && saved?.subId !== null && saved?.subLang) activeSubId = tracks.find((x) => x.sub.lang === saved.subLang)?.sub.id;
  // Nothing asked, saved or carried over: the first language in Settings when automatic subtitles are on, as the browser
  // does. Like there, only one language is tried: a saved or carried one with no track in it means none.
  const st = getState().settings, auto = (st.autoSubs ?? true) ? st.subLangs?.[0] : undefined;
  if (!activeSubId && auto && subId === undefined && saved?.subId !== null && !saved?.subLang && !opts.preferLang) activeSubId = tracks.find((x) => x.sub.lang === auto)?.sub.id;
  const active = tracks.find((x) => x.sub.id === activeSubId);

  const upnextToken = Math.random().toString(36).slice(2, 10);
  const c: Current = { device: dev, session, req, infoHash: t.infoHash, fileIdx: idx, mode: d.mode, hlsId, startOffset, duration: p.duration, tracks, activeSubId, subOffsetMs, rawAt: 0, lastSave: 0, finished: false, loading: true, upnextToken, upnextTrackId: tracks.length + 1, subs: known };
  if (old && reuse) release(old);   // the new stream is ready: save where the old one was, stop its ffmpeg
  commit(c);

  // The TV's media timeline starts at 0 = startOffset into the film, but the
  // VTT files carry absolute times: shift them back by the session start.
  const trackOffsetMs = Math.round(subOffsetMs - startOffset * 1000);
  const media = {
    contentId: url, contentType, streamType: 'BUFFERED' as const,
    metadata: { type: 0, metadataType: 0, title: req.title, images: req.poster ? [{ url: req.poster }] : [] },
    tracks: [
      ...tracks.map((x) => ({ trackId: x.trackId, type: 'TEXT' as const, trackContentId: `${base()}${x.sub.url}${trackOffsetMs ? `?offset=${trackOffsetMs}` : ''}`, trackContentType: 'text/vtt', subtype: 'SUBTITLES' as const, name: x.sub.label, language: x.sub.lang })),
      // Up-next overlay: the active subtitle's cues plus a countdown, generated when the TV fetches it (see upnextVtt).
      ...(type === 'series' ? [{ trackId: c.upnextTrackId!, type: 'TEXT' as const, trackContentId: `${base()}/api/cast/upnext/${upnextToken}.vtt`, trackContentType: 'text/vtt', subtype: 'SUBTITLES' as const, name: 'Up next', language: 'und' }] : []),
    ],
    // Netflix look: clean white sans, no box, soft black shadow, a touch larger than the receiver default.
    textTrackStyle: { backgroundColor: '#00000000', foregroundColor: '#FFFFFFFF', edgeType: 'DROP_SHADOW', edgeColor: '#000000FF', fontScale: 1.25, fontFamily: 'Droid Sans', fontGenericFamily: 'SANS_SERIF', fontStyle: 'NORMAL', windowType: 'NONE' },
  };
  log.info('load', { device: dev.name, mode: d.mode, url, sub: active?.sub.label, startOffset, reason: d.reason });
  try {
    // HLS sessions begin at the keyframe before the requested second: land on the second itself.
    await session.load(media, { currentTime: d.mode === 'direct' ? (req.startTime || 0) : Math.max(0, (req.startTime || 0) - startOffset), activeTrackIds: active ? [active.trackId] : [] });
  } catch (e) {
    if (gone()) { await abandon(c); return status(); }
    // Let the device go: status turns idle, a DLNA TV can be adopted again and the cast's ffmpeg stops.
    if (cur === c) await teardown(c, false);
    throw httpError(502, `Chromecast refused the stream: ${errMsg(e)}`);
  }
  c.loading = false;
  if (gone()) return status();
  // A subtitle picked while the TV loaded went to c.activeSubId, not the TV (setSubtitle): show it now, and the next one while it switches.
  for (let sent = active?.sub.id; c.activeSubId !== sent && !gone();) {
    const want = c.activeSubId, tr = tracks.find((x) => x.sub.id === want);
    try { await session.setTracks(tr ? [tr.trackId] : []); sent = want; }
    catch (e) { log.warn('subtitle switch after load failed', { err: errMsg(e) }); c.activeSubId = sent; }
  }
  if (gone()) return status();
  settle(gen);
  const shown = tracks.find((x) => x.sub.id === c.activeSubId);
  if (req.videoId) persist(c, req.startTime || 0);
  if (req.videoId && (subId !== undefined || shown)) saveSubChoice(req.videoId, { subId: shown?.sub.id ?? null, subLang: shown?.sub.lang, subOffsetMs });
  publish();
  return lastStatus;
}

/** End the Chromecast cast, if one plays: a DLNA start takes over once its TV answered. */
async function endCast(): Promise<void> { if (cur) await teardown(cur, false); }

/** Make `c` the cast: its connection's reports and close land on it now. */
function commit(c: Current): void {
  cur = c;
  const s = c.session;
  s.removeAllListeners('status'); s.removeAllListeners('close');
  s.on('status', (st: RawStatus) => onStatus(c, st));
  s.on('close', () => { if (cur === c) { log.info('device connection closed'); cur = null; release(c); publish(); } });
  publish();
}

/** Let go of what a cast holds besides its connection: save where it was, stop its ffmpeg. */
function release(c: Current): void {
  // Not while loading: the receiver may still report the previous media's time, which is not a position in this one.
  if (c.req.videoId && c.raw && c.raw.state !== 'IDLE' && !c.finished && !c.loading) persist(c, c.raw.currentTime + c.startOffset);
  if (c.hlsId) io.hls.stop(c.hlsId);
}

/** End a cast for good: its stream, the media on the TV, the receiver app and the connection. */
async function teardown(c: Current, haNotify: boolean): Promise<void> {
  if (cur === c) cur = null;
  release(c);
  if (haNotify) haEvent('stop', { title: c.req.title, target: c.device.name });
  try { await c.session.stop(); } catch { /* receiver may be gone */ }
  await discard(c.session);
  publish();
}

/** The new stream on the same connection failed before it reached the TV: the old cast plays on if its stream is still there, else it ends. */
async function keepOrEnd(old: Current): Promise<void> {
  if (cur !== old) return;
  const intact = !old.loading && old.raw?.state !== 'IDLE' && (!old.hlsId || io.hls.revive(old.hlsId));
  if (intact) { log.info('new stream failed, the old one plays on'); return; }
  await teardown(old, false);
}

/** A start that lost after it took the TV, and whose load failed: end it, unless a newer start for this TV is about to replace it. */
async function abandon(c: Current): Promise<void> { if (cur === c && !replacing(c)) await teardown(c, false); }

/** A connection opened by a start that lost. When the newest command wants the same TV, its receiver app stays up for it. */
async function dropFresh(session: CastSession, deviceId: string): Promise<void> { if (target === deviceId) session.destroy(); else await discard(session); }

export async function pause(): Promise<void> { if (dlna.active()) return viaDlna(() => dlna.pause()); const c = cur; if (c) await tv('pause', () => c.session.pause()); }
export async function resume(): Promise<void> { if (dlna.active()) return viaDlna(() => dlna.resume()); const c = cur; if (c) await tv('play', () => c.session.play()); }
export async function setVolume(v: { level?: number; muted?: boolean }): Promise<void> { if (dlna.active()) return viaDlna(() => dlna.setVolume(dlna.status().deviceId!, v)); const c = cur; if (c) await tv('volume', () => c.session.setVolume(v)); }

/** What a seek or subtitle shift restarts from: a restart still starting (it carries the newest choices), else the cast itself. */
function restartBase(c: Current): { req: CastPlayRequest; opts: CastOpts; at: number } {
  const p = restartOf(c);
  if (p) return { req: p, opts: pending?.opts || {}, at: p.startTime || 0 };
  return { req: { ...c.req, subId: c.activeSubId ?? null, subOffsetMs: c.subOffsetMs }, opts: c.subs ? { subs: c.subs } : {}, at: (c.raw?.currentTime || 0) + c.startOffset };
}

export async function seek(time: number): Promise<void> {
  if (dlna.active()) return viaDlna(() => dlna.seek(time));
  const c = cur;
  if (!c) return;
  if (c.mode === 'direct' && !restartOf(c)) { await tv('seek', () => c.session.seek(time)); return; }
  // HLS on the old Chromecast: the receiver reads the growing playlist as a live broadcast whose
  // seekable window ends at its own stale copy, so SEEK gets clamped straight back to where it was
  // (measured 2026-09-13: edge 472 s while ffmpeg had 892 s). A fresh session at the target plays
  // within 3 to 4 s; reloading the same playlist at an offset took 10 s of buffering.
  // A press while one is still starting replaces it: a burst of presses ends in one load at the last time.
  const b = restartBase(c);
  await run({ ...b.req, startTime: time }, b.opts, true);
}

export async function setSubtitle(subId: string | null, offsetMs?: number): Promise<void> {
  if (dlna.active()) return viaDlna(() => dlna.setSubtitle(subId, offsetMs));
  if (!cur) return;
  const c = cur;
  const b = restartBase(c);
  const was = b.req.subOffsetMs ?? c.subOffsetMs;   // a shift still starting counts, so shifting back restarts too
  const off = offsetMs ?? was;
  if (off !== was) {
    await run({ ...b.req, startTime: b.at, subId: subId || null, subOffsetMs: off }, b.opts, true);
    return;
  }
  const tr = subId ? c.tracks.find((x) => x.sub.id === subId) : undefined;
  const p = restartOf(c);
  if (p && pending) {
    // A seek or shift is starting (3 to 4 s): the pick goes with it, or the restarted session would load the old one.
    // Picked before its tracks are set, the load carries it; picked while the TV loads, start() switches once it is in.
    pending.req = { ...p, subId: subId || null };
    c.activeSubId = tr?.sub.id;
    // The old media plays on meanwhile: show the pick there too (and keep it if the restart fails). Not during a load.
    if (!c.loading) c.session.setTracks(tr ? [tr.trackId] : []).catch((e) => log.debug('subtitle switch before restart failed', { err: errMsg(e) }));
    publish();
    return;
  }
  await tv('subtitle switch', () => c.session.setTracks(tr ? [tr.trackId] : []));
  c.activeSubId = tr?.sub.id;
  if (c.req.videoId) saveSubChoice(c.req.videoId, { subId: tr?.sub.id ?? null, subLang: tr?.sub.lang, subOffsetMs: c.subOffsetMs });
  publish();
}

/** Quit Kino's receiver app and close a connection that no cast holds. */
async function discard(session: CastSession): Promise<void> {
  try { await session.quit(); } catch { /* ignore */ }
  session.destroy();
}

export async function stop(haNotify = true): Promise<void> {
  nextGen(); target = null; pending = null;   // a start still working gives up at its next step
  const c = cur;
  if (dlna.active()) await dlna.stop(haNotify);
  if (c && cur === c) await teardown(c, haNotify); else publish();
}

/** Stop casting and return where playback was, so a phone can pick it up. */
export async function handoff(): Promise<{ videoId?: string; pos: number; infoHash: string; fileIdx: number; title: string; poster?: string } | null> {
  if (dlna.active()) { const h = dlna.handoffInfo(); await dlna.stop(); return h; }
  const c = cur;
  if (!c) return null;
  const pos = (c.raw?.currentTime || 0) + c.startOffset;
  await stop();
  return { videoId: c.req.videoId, pos, infoHash: c.infoHash, fileIdx: c.fileIdx, title: c.req.title, poster: c.req.poster };
}

// ------------------------------------------------------------- up next ----
/** Receiver timeline position right now: last reported time plus what has elapsed since, while playing. */
function receiverTime(c: Current): number {
  const r = c.raw; if (!r) return 0;
  return r.currentTime + (r.state === 'PLAYING' && c.rawAt ? (Date.now() - c.rawAt) / 1000 : 0);
}
/** Activate the synthetic track on the Chromecast (the TV draws the countdown) or put the subtitle back. */
async function showUpNextOnTv(show: boolean): Promise<void> {
  const c = cur; if (!c || !c.upnextTrackId || c.loading) return;
  const sub = c.activeSubId ? c.tracks.find((x) => x.sub.id === c.activeSubId) : undefined;
  try { await c.session.setTracks(show ? [c.upnextTrackId] : sub ? [sub.trackId] : []); }
  catch (e) { log.debug('up-next track switch failed', { err: errMsg(e) }); }
}
/** The VTT the TV fetches when the up-next track goes active: the active subtitle's cues plus the countdown, on the receiver's clock. */
export async function upnextVtt(token: string): Promise<string | null> {
  const c = cur; if (!c || c.upnextToken !== token) return null;
  let body = 'WEBVTT\n\n';
  const sub = c.activeSubId ? c.tracks.find((x) => x.sub.id === c.activeSubId) : undefined;
  if (sub) { try { body = await getVtt(sub.sub.id, Math.round(c.subOffsetMs - c.startOffset * 1000), getTorrent); if (!body.endsWith('\n\n')) body += '\n\n'; } catch (e) { log.debug('up-next: subtitle unavailable', { err: errMsg(e) }); } }
  return body + upnext.countdownCues(upnext.current(), receiverTime(c)).join('\n\n') + '\n';
}

// ---------------------------------------------------------------- wiring ----
let wired = false;
/**
 * Hook up the DLNA side, the HLS reaper and the up-next timer. Once, at boot (server/index.ts): importing this module
 * starts nothing. Not start(): that name is the cast start below run().
 */
export function init(): void {
  if (wired) return;
  wired = true;
  // The DLNA side publishes through here too, so its status carries the same up-next decoration.
  dlna.events.on('status', () => emit('cast.status', status()));
  dlna.setAdoptGuard(() => !cur);
  dlna.events.on('finished', (i: { videoId?: string; deviceId: string; subLang?: string; subOffsetMs: number }) => { void autoNext(i.videoId, i.deviceId, i.subLang, i.subOffsetMs); });
  // The reaper spares only the session casting now: one dropped without hls.stop stops after the idle window.
  hls.setCastKeep((s) => !!cur && s.id === cur.hlsId);
  upnext.start({ status, castNext, publish, onShow: () => void showUpNextOnTv(true), onHide: () => void showUpNextOnTv(false) });
}
