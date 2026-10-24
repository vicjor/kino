import { EventEmitter } from 'node:events';
import { Client, DefaultMediaReceiver, type MediaInfo, type MediaStatus } from 'castv2-client';
import { logger } from '../log.js';
import { httpError, ownStatus, type HttpError } from '../errors.js';
import { withTimeout } from './timeout.js';

const log = logger('cast.session');
const CMD_MS = 8_000;
const LOAD_MS = 90_000;   // LOAD is answered only once the receiver has loaded the media; a cold torrent can take a while

export interface RawStatus { state: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED'; currentTime: number; duration?: number; volume: number; muted: boolean; activeTrackIds: number[]; idleReason?: string }

/**
 * castv2-client's Client never emits 'close': when the device closes the socket without an error it
 * only drops its controllers, and every later call throws "Cannot read properties of null". Listen on
 * the castv2 socket client it wraps instead.
 */
export function onSocketClose(client: Client, fn: () => void): void {
  (client as unknown as { client?: EventEmitter | null }).client?.once('close', fn);
}

/** What the phone shows when a TV never answered, on either transport. */
export const noAnswer = () => httpError(504, 'The TV did not answer');
/** What the phone shows when Kino cannot reach a TV at all (refused, unreachable, asleep), on either transport. */
export const unreachable = () => httpError(503, 'Kino could not reach the TV. Is it on and connected to this Wi-Fi?');

/**
 * What the phone shows when the app on a Cast device turns a command down. castv2-client fails the request with
 * "Invalid request: <reason>": the media session it named is gone (the app moved on to other media, or stopped), or
 * the app does not take that command (seeking a live stream, an app that lets only its own phones control it).
 */
function refusedByApp(reason: string): HttpError {
  return httpError(409, reason === 'INVALID_MEDIA_SESSION_ID' ? 'What was playing on the TV has changed. Try again.' : 'The app on the TV does not let Kino do that');
}

/**
 * What the phone shows when a Chromecast never answered ("Chromecast refused the stream: Chromecast load timed out
 * after 90 s", "Living room TV pause timed out after 6 s") or its app refused the command ("Invalid request:
 * INVALID_COMMAND", see refusedByApp): plain words. Anything else passes through; the caller logs the detail.
 */
export function plainCastError(e: unknown): unknown {
  const m = e instanceof Error ? e.message : String(e);
  if (/\btimed out after \d+(?:\.\d+)? s\b|Chromecast connect timeout/.test(m)) return noAnswer();
  const invalid = e instanceof Error && ownStatus(e) === undefined ? /^Invalid request: (\S*)/.exec(m) : null;
  return invalid ? refusedByApp(invalid[1]) : e;
}

/**
 * castv2-client's request() keeps its 'message' listener on the controller until the answer comes, so each
 * request the TV never answers leaves one behind. Run `send` and get back what removes the ones it added.
 */
export function listenersAddedBy(em: EventEmitter | undefined, event: string, send: () => void): () => void {
  const before = new Set(em?.listeners(event));
  send();
  const added = em ? em.listeners(event).filter((l) => !before.has(l)) : [];
  return () => { for (const l of added) em!.removeListener(event, l as (...a: unknown[]) => void); };
}

/** Where castv2-client requests wait for their answer: the receiver channel of a Client (status, volume, stop) and the media channel of an app. */
const emitter = (x: unknown): EventEmitter | undefined => (x instanceof EventEmitter ? x : undefined);
export const receiverOf = (c: Client): EventEmitter | undefined => emitter((c as unknown as { receiver?: unknown }).receiver);
export const mediaOf = (p: DefaultMediaReceiver): EventEmitter | undefined => emitter((p as unknown as { media?: unknown }).media);

/**
 * One castv2-client request on controller `on`, bounded by `ms`, its fail function in `waiting` until it settles. However it
 * ends (answered, refused, timed out, failed through `waiting`), the listener it left on `on` comes off: castv2-client only
 * removes it when the answer comes, so each request the TV never answered would stay until the socket closes.
 */
export function castRequest<T>(on: EventEmitter | undefined, ms: number, label: string, send: (done: (e: Error | null, v?: T) => void) => void, waiting?: Set<(e: Error) => void>): Promise<T> {
  let drop = () => {}; let fail = (_e: Error) => {};
  const p = new Promise<T>((resolve, reject) => { fail = reject; waiting?.add(fail); drop = listenersAddedBy(on, 'message', () => send((e, v) => (e ? reject(e) : resolve(v as T)))); });
  return withTimeout(p, ms, label).finally(() => { waiting?.delete(fail); drop(); });
}

/** A command on a session that is closed, or whose player never opened. */
const notConnected = () => httpError(503, 'Chromecast is not connected');

/** One TCP connection + DefaultMediaReceiver on a Chromecast. Emits 'status' and 'close'. */
export class CastSession extends EventEmitter {
  private client = new Client();
  private player?: DefaultMediaReceiver;
  private poll?: NodeJS.Timeout;
  private polling = false;
  private closed = false;
  private waiting = new Set<(e: Error) => void>();
  last?: RawStatus;

  constructor(public host: string, public port = 8009) { super(); }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Any failure before the receiver app is up closes the socket, so nothing is left polling a session nobody holds.
      let settled = false;
      const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(to); this.destroy(); reject(e); };
      const to = setTimeout(() => fail(new Error('Chromecast connect timeout')), 10_000);
      // Before the player is up, a socket error (refused, unreachable, no heartbeat) means the TV cannot be reached.
      this.client.on('error', (e: Error) => { log.warn('client error', { err: e.message }); fail(unreachable()); this.destroy(); });
      onSocketClose(this.client, () => { fail(httpError(502, 'Chromecast closed the connection')); this.destroy(); });
      this.client.connect({ host: this.host, port: this.port }, () => {
        if (settled) return;
        this.client.launch<DefaultMediaReceiver>(DefaultMediaReceiver, (err, player) => {
          if (settled) { try { player?.close(); } catch { /* ignore */ } return; }
          if (err || !player) { log.warn('launch failed', { err: err?.message }); return fail(httpError(502, 'Chromecast could not open its video player')); }
          settled = true; clearTimeout(to);
          this.player = player;
          player.on('status', (s: MediaStatus) => this.onStatus(s));
          player.on('close', () => this.destroy());
          this.poll = setInterval(() => this.pollStatus(player), 2000);
          this.poll.unref();
          resolve();
        });
      });
    });
  }

  /** Ask for the media status: one request at a time, bounded like a command. */
  private pollStatus(p: DefaultMediaReceiver): void {
    if (this.polling || this.closed || this.player !== p) return;
    this.polling = true;
    this.request<MediaStatus | null>(mediaOf(p), CMD_MS, 'Chromecast status', (done) => p.getStatus(done))
      .then((s) => { if (!this.closed) this.onStatus(s); }, () => undefined)
      .finally(() => { this.polling = false; });
  }

  private onStatus(s: MediaStatus | null): void {
    if (!s) return;
    const st: RawStatus = { state: s.playerState, currentTime: s.currentTime || 0, duration: s.media?.duration, volume: s.volume?.level ?? 1, muted: !!s.volume?.muted, activeTrackIds: s.activeTrackIds || [], idleReason: s.idleReason };
    this.last = st;
    this.emit('status', st);
  }

  /**
   * One request to the receiver (castRequest). castv2-client never fails a request when the connection
   * goes, so destroy() fails the ones still waiting: a cast stopped mid-load answers now, not after 90 s.
   */
  private request<T>(on: EventEmitter | undefined, ms: number, label: string, send: (done: (e: Error | null, v?: T) => void) => void): Promise<T> {
    return castRequest<T>(on, ms, label, send, this.waiting);
  }
  load(media: MediaInfo, opts: { currentTime?: number; activeTrackIds?: number[] }): Promise<MediaStatus> {
    const p = this.player;
    if (this.closed || !p) return Promise.reject(notConnected());
    return this.request<MediaStatus>(mediaOf(p), LOAD_MS, 'Chromecast load', (done) => p.load(media, { autoplay: true, currentTime: opts.currentTime || 0, activeTrackIds: opts.activeTrackIds || [] }, done));
  }
  private cmd(what: string, fn: (p: DefaultMediaReceiver, cb: (e: Error | null) => void) => void): Promise<void> {
    const p = this.player;
    if (this.closed || !p) return Promise.reject(notConnected());
    return this.request<void>(mediaOf(p), CMD_MS, `Chromecast ${what}`, (done) => fn(p, (e) => done(e)));
  }
  play(): Promise<void> { return this.cmd('play', (p, cb) => p.play(cb)); }
  pause(): Promise<void> { return this.cmd('pause', (p, cb) => p.pause(cb)); }
  stop(): Promise<void> { return this.cmd('stop', (p, cb) => p.stop(cb)); }
  seek(t: number): Promise<void> { return this.cmd('seek', (p, cb) => p.seek(t, cb)); }
  setTracks(ids: number[]): Promise<void> { return this.cmd('subtitle switch', (p, cb) => p.media.sessionRequest({ type: 'EDIT_TRACKS_INFO', activeTrackIds: ids }, (e) => cb(e))); }
  /** Close Kino's receiver app so the TV goes back to its ambient screen. The
   *  monitor keeps a joined sender on our app, which would otherwise keep the
   *  Default Media Receiver's idle screen up forever. */
  quit(): Promise<void> {
    const p = this.player;
    if (this.closed || !p) return Promise.resolve();
    return castRequest<void>(receiverOf(this.client), 3000, 'Chromecast quit', (done) => this.client.stop(p, (e) => done(e))).catch(() => undefined);
  }
  setVolume(v: { level?: number; muted?: boolean }): Promise<void> {
    if (this.closed) return Promise.reject(notConnected());
    return this.request<void>(receiverOf(this.client), CMD_MS, 'Chromecast volume', (done) => this.client.setVolume(v, (e) => done(e)));
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    try { this.player?.close(); } catch { /* ignore */ }
    try { this.client.close(); } catch { /* ignore */ }
    for (const fail of [...this.waiting]) fail(httpError(502, 'Chromecast connection closed'));
    this.emit('close');
    log.info('session closed', { host: this.host });
  }
}
