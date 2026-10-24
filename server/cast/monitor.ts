import { Client, DefaultMediaReceiver, type ReceiverApp, type ReceiverStatus, type MediaStatus } from 'castv2-client';
import type { EventEmitter } from 'node:events';
import { logger, errMsg } from '../log.js';
import { httpError, statusOf } from '../errors.js';
import { emit, clientCount, send, onClientConnect } from '../events.js';
import * as discovery from './discovery.js';
import * as manager from './manager.js';
import * as dlna from './dlna.js';
import { addCastHistory, castHistory } from '../store.js';
import { onSocketClose, castRequest, receiverOf, mediaOf, plainCastError } from './session.js';
import type { CastDevice, ReceiverInfo, CastHistoryEntry } from '../types.js';

const log = logger('cast.monitor');

// One long-lived sender connection per Cast device, exactly like the Google
// Home app keeps: receiver status (volume, running app) is pushed to us, and
// when the app speaks the media namespace we join its session so title,
// artwork, position and play state stream in too, whoever started the cast.
// Throwaway connections per poll would churn 6 devices every few seconds.

const MEDIA_NS = 'urn:x-cast:com.google.cast.media';
const IDLE_APPS = new Set(['E8C28D3C']);   // Backdrop / ambient screen
const RECONNECT_MIN = 5_000;
const RECONNECT_MAX = 120_000;
const MEDIA_POLL_MS = 4_000;
const CMD_MS = 6_000;
const CONNECT_MS = 8_000;
/** A connected device we have not heard from this long gets asked for its status. */
const PROBE_AFTER_MS = 10_000;
/** A connected device that has said nothing this long (two probes unanswered) gets a fresh connection. */
const SILENT_MS = 30_000;
const WATCHDOG_MS = 5_000;

type Cmd = 'stop' | 'pause' | 'play' | 'volume' | 'seek';
/** One request on a receiver or media channel, bounded by CMD_MS, its listener taken back if the device never answers. */
const cb = <T>(on: EventEmitter | undefined, label: string, fn: (k: (e: Error | null, v?: T) => void) => void) => castRequest<T>(on, CMD_MS, label, fn);
const runningApps = (apps?: ReceiverApp[]) => (apps || []).filter((a) => !IDLE_APPS.has(a.appId));
const hasMedia = (a: ReceiverApp) => (a.namespaces || []).some((n) => n.name === MEDIA_NS);

/**
 * What the watchdog does with a connected device last heard from at `lastHeard`. A half-open socket
 * (Wi-Fi blip, TV asleep) can stay "connected" while nothing comes back, and the entry goes stale.
 */
export function watchdogAction(now: number, lastHeard: number): 'ok' | 'probe' | 'reconnect' {
  const quiet = now - lastHeard;
  return quiet >= SILENT_MS ? 'reconnect' : quiet >= PROBE_AFTER_MS ? 'probe' : 'ok';
}

class Watcher {
  info: ReceiverInfo;
  private client: Client | null = null;
  private app: DefaultMediaReceiver | null = null;
  private appSession?: string;
  private apps: ReceiverApp[] = [];
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private backoff = RECONNECT_MIN;
  private gen = 0;
  /** Drops the current connection and schedules the next one; null while not connected. */
  private abort: ((why: string) => void) | null = null;
  private probing = -1;   // gen of the receiver status request in flight
  private mediaPending: DefaultMediaReceiver | null = null;
  /** Epoch ms of the last answer of any kind from the device. */
  lastHeard = 0;
  dead = false;

  constructor(public device: CastDevice, private newClient: () => Client = () => new Client()) {
    this.info = { id: device.id, name: device.name, model: device.model, audioOnly: device.audioOnly, online: false, volume: 0, muted: false, kino: false, updatedAt: 0 };
    this.connect();
  }

  private connect(): void {
    if (this.dead || this.client) return;
    const gen = ++this.gen;
    const client = this.newClient();
    this.client = client;
    let to: NodeJS.Timeout | undefined;
    const fail = (why: string) => {
      if (this.gen !== gen) return;
      clearTimeout(to);
      this.gen++;   // anything still in flight on this client is ignored from here on
      try { client.close(); } catch { /* already closed */ }
      this.client = null; this.abort = null;
      this.dropApp();
      const was = this.info.online;
      this.info = { ...this.info, online: false, app: undefined, media: undefined, updatedAt: Date.now() };
      if (was) log.info('offline', { device: this.device.name, why });
      publish();
      this.schedule();
    };
    this.abort = fail;
    client.on('error', (e: Error) => fail(e.message));
    onSocketClose(client, () => fail('closed'));
    client.on('status', (st: ReceiverStatus) => { if (this.gen === gen) this.apply(st); });
    // Covers the TCP connect AND the first status: a device that accepts the socket but never answers would
    // otherwise sit offline with a live client forever (refresh() only reconnects when there is no client).
    to = setTimeout(() => { if (!this.info.online) fail('connect timeout'); }, CONNECT_MS);
    try {
      client.connect({ host: this.device.host, port: this.device.port }, () => {
        if (this.gen !== gen) return;
        client.getStatus((err, st) => {
          if (this.gen !== gen) return;
          if (err) return fail(err.message);
          clearTimeout(to); this.backoff = RECONNECT_MIN;
          this.info.online = true; log.info('online', { device: this.device.name }); this.apply(st);
        });
      });
    } catch (e) { fail(errMsg(e)); }
  }

  /** Ask for the receiver status, with a timeout and at most one request in flight. */
  private probe(): void {
    const client = this.client; const gen = this.gen;
    if (!client || this.probing === gen) return;
    this.probing = gen;
    cb<ReceiverStatus>(receiverOf(client), `${this.device.name} status`, (k) => client.getStatus(k))
      .then((st) => { if (this.gen === gen) this.apply(st); }, () => { /* the watchdog decides */ })
      .finally(() => { if (this.probing === gen) this.probing = -1; });
  }

  /** Same for the joined media session. */
  private pollMedia(p: DefaultMediaReceiver): void {
    if (this.app !== p || this.mediaPending === p) return;
    this.mediaPending = p;
    cb<MediaStatus | null>(mediaOf(p), `${this.device.name} media status`, (k) => p.getStatus(k))
      .then((m) => { if (this.app === p) this.onMedia(m); }, () => { /* next poll */ })
      .finally(() => { if (this.mediaPending === p) this.mediaPending = null; });
  }

  /** Watchdog step: probe a quiet connected device, start over with one that stays silent. It stays listed. */
  check(now: number): void {
    if (!this.client || !this.info.online) return;
    const act = watchdogAction(now, this.lastHeard);
    if (act === 'probe') this.probe();
    else if (act === 'reconnect') { log.info('silent, reconnecting', { device: this.device.name, quietMs: now - this.lastHeard }); this.abort?.('silent'); }
  }

  private schedule(): void {
    if (this.dead || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.backoff);
    this.timer.unref();
    this.backoff = Math.min(RECONNECT_MAX, this.backoff * 2);
  }

  private apply(st: ReceiverStatus): void {
    this.lastHeard = Date.now();
    this.apps = runningApps(st.applications);
    const app = this.apps[0];
    this.info = {
      ...this.info, online: true, updatedAt: Date.now(),
      volume: st.volume?.level ?? this.info.volume, muted: !!st.volume?.muted,
      app: app ? { id: app.appId, name: app.displayName || app.appId, status: app.statusText || undefined } : undefined,
      kino: kinoOn(this.device.id),
    };
    if (!app) { this.dropApp(); this.info.media = undefined; }
    else if (app.sessionId !== this.appSession) { this.dropApp(); this.info.media = undefined; if (hasMedia(app)) this.join(app); }
    publish();
  }

  private join(app: ReceiverApp): void {
    const client = this.client; if (!client) return;
    const gen = this.gen;
    this.appSession = app.sessionId;
    client.join<DefaultMediaReceiver>(app, DefaultMediaReceiver, (err, p) => {
      if (err || !p || this.gen !== gen || this.appSession !== app.sessionId) { try { p?.close(); } catch { /* ignore */ } return; }
      this.app = p;
      p.on('status', (m: MediaStatus) => { if (this.app === p) this.onMedia(m); });
      p.on('close', () => { if (this.app === p) { this.app = null; this.info.media = undefined; publish(); } });
      this.pollMedia(p);
      this.poll = setInterval(() => this.pollMedia(p), MEDIA_POLL_MS);
      this.poll.unref();
    });
  }

  private onMedia(m: MediaStatus | null): void {
    this.lastHeard = Date.now();
    if (!m) { this.info.media = undefined; publish(); return; }
    const meta = (m.media?.metadata || {}) as Record<string, unknown>;
    const str = (k: string) => (typeof meta[k] === 'string' && (meta[k] as string).trim() ? (meta[k] as string) : undefined);
    const images = Array.isArray(meta.images) ? (meta.images as { url?: string }[]) : [];
    this.info.media = {
      state: m.playerState, title: str('title'), subtitle: str('subtitle') || str('artist') || str('seriesTitle') || str('albumName'),
      artwork: images.find((i) => typeof i?.url === 'string')?.url,
      currentTime: m.currentTime || 0, duration: m.media?.duration && m.media.duration > 0 ? m.media.duration : undefined, contentType: m.media?.contentType,
    };
    // Kino's own HLS cast: the TV counts from the session start and reports no duration (a growing
    // playlist looks live to it). The manager knows the film's absolute position and real length.
    if (kinoOn(this.device.id)) { const k = manager.status(); if (k.active && k.currentTime != null) { this.info.media.currentTime = k.currentTime; if (k.duration) this.info.media.duration = k.duration; } }
    this.info.updatedAt = Date.now();
    if (this.info.media.title && this.info.app && m.playerState !== 'IDLE') this.remember(this.info.media.title, this.info.media.subtitle, this.info.media.artwork);
    publish();
  }

  private remember(title: string, subtitle?: string, artwork?: string): void {
    const e: CastHistoryEntry = { ts: Date.now(), app: this.info.app?.name || 'Cast', title, subtitle, artwork };
    const k = manager.status();
    if (k.active && k.deviceId === this.device.id && k.infoHash != null) e.kino = { videoId: k.videoId, infoHash: k.infoHash, fileIdx: k.fileIdx ?? -1, title: k.title || title, poster: k.poster, type: k.type || 'movie' };
    if (addCastHistory(this.device.id, e)) log.info('history', { device: this.device.name, app: e.app, title });
  }

  private dropApp(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    const p = this.app; this.app = null; this.appSession = undefined;
    if (p) { try { p.close(); } catch { /* ignore */ } }
  }

  /** Nudge a stale entry: ask the device for a fresh receiver status. */
  refresh(): void {
    if (!this.client || !this.info.online) { if (!this.client) { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.backoff = RECONNECT_MIN; this.connect(); } return; }
    this.probe();
    if (this.app) this.pollMedia(this.app);
  }

  /**
   * One command. A device that never answers reads "The TV did not answer", a command its app turns down a 409 in
   * words (plainCastError); the detail goes to the log.
   */
  async command(cmd: Cmd, body: { level?: number; muted?: boolean; time?: number }): Promise<void> {
    try { await this.send(cmd, body); }
    catch (e) {
      const out = plainCastError(e);
      if (out !== e) log.warn(statusOf(out) === 504 ? 'no answer from the device' : 'the app on the device refused', { device: this.device.name, app: this.info.app?.name, cmd, err: errMsg(e) });
      throw out;
    }
  }

  private async send(cmd: Cmd, body: { level?: number; muted?: boolean; time?: number }): Promise<void> {
    const client = this.client;
    if (!client || !this.info.online) throw httpError(503, `${this.device.name} is offline`);
    const label = `${this.device.name} ${cmd}`;
    if (cmd === 'volume') { await cb(receiverOf(client), label, (k) => client.setVolume({ level: body.level, muted: body.muted }, k)); return; }
    if (cmd === 'stop') {
      const apps = this.apps;
      if (!apps.length) return;
      this.dropApp();
      // Client.stop wants an Application: only .session and .close() are used.
      for (const a of apps) await cb(receiverOf(client), label, (k) => client.stop({ session: a, close() { /* nothing joined */ } }, k));
      return;
    }
    const p = this.app;
    if (!p) throw httpError(409, 'Nothing controllable is playing');
    if (cmd === 'seek') await cb(mediaOf(p), label, (k) => p.seek(Math.max(0, body.time || 0), k));
    else await cb(mediaOf(p), label, (k) => (cmd === 'pause' ? p.pause(k) : p.play(k)));
    this.pollMedia(p);
  }

  destroy(): void {
    this.dead = true; this.gen++; this.abort = null;
    if (this.timer) clearTimeout(this.timer);
    this.dropApp();
    try { this.client?.close(); } catch { /* ignore */ }
    this.client = null;
  }
}

const watchers = new Map<string, Watcher>();
let syncTimer: NodeJS.Timeout | null = null;
let dogTimer: NodeJS.Timeout | null = null;
let pubTimer: NodeJS.Timeout | null = null;

function kinoOn(deviceId: string): boolean { const s = manager.status(); return s.active && s.deviceId === deviceId; }

/** Throttled SSE broadcast of the whole list (many devices report at once). */
function publish(): void {
  if (pubTimer) return;
  pubTimer = setTimeout(() => { pubTimer = null; if (clientCount()) emit('cast.receivers', list()); }, 150);
}

function sync(): void {
  for (const d of discovery.list()) {
    if (d.kind === 'dlna') continue;
    const w = watchers.get(d.id);
    if (!w) watchers.set(d.id, new Watcher(d));
    else if (w.device.host !== d.host || w.device.port !== d.port) { w.destroy(); watchers.set(d.id, new Watcher(d)); }
  }
}

export function start(): void {
  dlna.events.on('receivers', publish);
  dlna.events.on('status', publish);
  onClientConnect((res) => send(res, 'cast.receivers', list()));
  sync();
  syncTimer = setInterval(sync, 10_000);
  syncTimer.unref();
  dogTimer = setInterval(() => { const now = Date.now(); for (const w of watchers.values()) w.check(now); }, WATCHDOG_MS);
  dogTimer.unref();
}

export function stop(): void {
  if (syncTimer) clearInterval(syncTimer);
  if (dogTimer) clearInterval(dogTimer);
  for (const w of watchers.values()) w.destroy();
  watchers.clear();
}

/** Current snapshot, TVs first, then speakers, then offline. */
export function list(): ReceiverInfo[] {
  return [...[...watchers.values()].map((w) => ({ ...w.info, kind: 'cast' as const, kino: kinoOn(w.device.id) })), ...dlna.receivers()]
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(!!b.app) - Number(!!a.app) || Number(a.audioOnly) - Number(b.audioOnly) || a.name.localeCompare(b.name));
}

export function refresh(): void { discovery.refresh(); sync(); for (const w of watchers.values()) w.refresh(); }

/** Run one command against one device. Kino's own session goes through the manager so its state stays coherent. */
export async function command(id: string, cmd: Cmd, body: { level?: number; muted?: boolean; time?: number } = {}): Promise<ReceiverInfo> {
  if (dlna.isDlnaId(id)) {
    const mine = dlna.active() && dlna.status().deviceId === id;
    if (!mine && !dlna.receiverInfo(id)) throw httpError(404, 'TV not found');
    if (cmd === 'volume') await manager.viaDlna(() => dlna.setVolume(id, { level: body.level, muted: body.muted }));
    else if (!mine) await manager.viaDlna(() => dlna.control(id, cmd, body.time || 0));
    else if (cmd === 'stop') await manager.stop();
    else if (cmd === 'pause') await manager.pause();
    else if (cmd === 'play') await manager.resume();
    else if (cmd === 'seek') await manager.seek(body.time || 0);
    const info = dlna.receiverInfo(id); if (!info) throw httpError(404, 'TV not found');
    return info;
  }
  const w = watchers.get(id);
  if (!w) throw httpError(404, 'Cast device not found');
  if (kinoOn(id)) {
    if (cmd === 'stop') await manager.stop();
    else if (cmd === 'pause') await manager.pause();
    else if (cmd === 'play') await manager.resume();
    else if (cmd === 'seek') await manager.seek(body.time || 0);
    else await manager.setVolume({ level: body.level, muted: body.muted });
  } else await w.command(cmd, body);
  log.info('cmd', { device: w.device.name, cmd, ...body });
  w.refresh();
  return { ...w.info, kino: kinoOn(id) };
}

/** Panic button: stop Kino's own session AND every app on every cast device on the LAN. */
export async function stopAll(): Promise<ReceiverInfo[]> {
  try { await manager.stop(); } catch (e) { log.warn('own session stop failed', { err: errMsg(e) }); }
  await Promise.all([...watchers.values()].map(async (w) => { try { if (w.info.online && w.info.app) await w.command('stop', {}); } catch (e) { w.info.error = errMsg(e); } }));
  const out = list();
  log.info('stop-all', { devices: out.length, errors: out.filter((r) => r.error).map((r) => `${r.name}:${r.error}`) });
  return out;
}

export function history(id: string): CastHistoryEntry[] { return castHistory(id); }

/** Tests only. */
export { Watcher as _Watcher };
