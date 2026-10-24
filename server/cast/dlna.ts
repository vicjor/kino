import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Torrent } from 'webtorrent';
import { PORT, lanIp, DATA_DIR } from '../config.js';
import { logger, errMsg } from '../log.js';
import { httpError, ownStatus } from '../errors.js';
import { getState, getProgress, saveProgress, saveSubChoice, writeAtomic, MIN_PROGRESS_SEC } from '../store.js';
import { adoptSubId } from '../subs/ids.js';
import { ensure, pickVideoFile } from '../torrent.js';
import { guard } from '../disk.js';
import { probe } from '../media/probe.js';
import { mimeFor } from '../media/range.js';
import { listSubtitles } from '../subs/index.js';
import { parseVideoId } from '../meta.js';
import { haEvent } from '../ha.js';
import * as lg from './lg.js';
import type { DecodeCaps } from '../score.js';
import type { CastDevice, CastPlayRequest, CastStatus, ReceiverInfo, SubtitleTrack, MediaType } from '../types.js';

const log = logger('dlna');

// DLNA / UPnP AV renderers: the LG webOS TV and most smart TVs. Same idea as
// Stremio's "play on device": SSDP finds them, SOAP drives AVTransport and
// RenderingControl. The TV pulls the raw file over HTTP and decodes it itself,
// so MKV, HEVC and 5.1 audio play without any transcoding.

/** What a renderer shows as is, for ranking its sources as a browser's (score.ts): HEVC, and HDR without tone-mapping. */
export const DECODES: DecodeCaps = { hevc: true, hdr: true };

interface Renderer extends CastDevice { kind: 'dlna'; location: string; avControl: string; rcControl: string; seenAt: number }

const AV = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const renderers = new Map<string, Renderer>();
const SSDP = '239.255.255.250';
let sock: dgram.Socket | null = null;
let listener: dgram.Socket | null = null;
let timer: NodeJS.Timeout | null = null;
/** Hosts that ever answered as a renderer. Searched by unicast too, because the LG answers a lone multicast search maybe one time in three. */
const knownHosts = new Set<string>();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (xml: string, name: string): string | undefined => { const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : undefined; };
// HH:MM:SS with two-digit hours: lax renderers have mangled "0:02:00" into something else.
const hms = (s: number) => { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const secs = (t?: string) => { if (!t || t === 'NOT_IMPLEMENTED') return 0; const p = t.split('.')[0].split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0; };

/** The TV answered an action with a UPnP error: a 502 in words for the phone, the action and the TV's error for the log. */
const refused = (detail: string) => Object.assign(httpError(502, 'The TV refused the command'), { detail });
const detailOf = (e: unknown): string => (e as { detail?: string } | null)?.detail || errMsg(e);
const notFound = () => httpError(404, 'TV not found. Is it on and connected to this Wi-Fi?');
/**
 * A load the TV turned down, in words that name it, the detail to the log. A TV that did not answer or cannot be reached
 * stays as it was: the manager's viaDlna words those.
 */
function refusedLoad(dev: Renderer, e: unknown): unknown {
  if (ownStatus(e) !== 502) return e;
  log.warn('renderer refused the stream', { device: dev.name, err: detailOf(e) });
  return Object.assign(httpError(502, `${dev.name} refused the stream`), { detail: detailOf(e) });
}

/** One SOAP action. `signal`: called off sooner than the timeout (a wake nobody waits for any more). */
async function soap(url: string, service: string, action: string, args: Record<string, string | number> = {}, timeoutMs = 8000, signal?: AbortSignal): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}"><InstanceID>0</InstanceID>${Object.entries(args).map(([k, v]) => `<${k}>${typeof v === 'number' ? v : esc(String(v))}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const limit = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` }, body, signal: signal ? AbortSignal.any([limit, signal]) : limit });
  const text = await res.text();
  if (!res.ok) { const code = tag(text, 'errorCode'); const desc = tag(text, 'errorDescription'); log.debug('renderer refused', { action, code, desc, status: res.status }); throw refused(`${action} failed: ${desc || code || res.status}`); }
  return text;
}

// ---------------------------------------------------------------- waking ----
/*
 * A TV that is off drops off the network. Kino remembers every renderer it has seen, with its MAC
 * from the ARP table, lists it as off, and wakes it with Wake-on-LAN when you cast to it.
 * The LG only listens for that with "Turn on via Wi-Fi" (Settings, General, Devices) switched on.
 */
interface Known { id: string; name: string; model: string; host: string; location: string; mac?: string }
const KNOWN_FILE = path.join(DATA_DIR, 'dlna-known.json');
const known = new Map<string, Known>((() => { try { return Object.entries(JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')) as Record<string, Known>); } catch { return []; } })());
/** Failed status checks in a row, per renderer: two and it counts as off, even before SSDP forgets it. */
const misses = new Map<string, number>();
/**
 * The wake running per renderer, one at a time, shared by every cast waiting on it (`waiters`): a cast that replaces
 * another for the same TV waits on the same wake, which goes on. `stop` calls it off once nobody waits any more.
 */
interface Wake { done: Promise<Renderer | undefined>; waiters: number; stop: AbortController }
const wakes = new Map<string, Wake>();
const asleep = (id: string) => cur?.dev.id !== id && (!renderers.has(id) || (misses.get(id) || 0) >= 2);
const offNoMac = (k: Known) => httpError(503, `${k.name} is off. Turn it on with the remote this once, and Kino can turn it on by itself after that.`);

function saveKnown(): void { try { writeAtomic(KNOWN_FILE, JSON.stringify(Object.fromEntries(known))); } catch (e) { log.debug('could not save renderers', { err: errMsg(e) }); } }
function know(id: string, k: Known): void {
  const prev = known.get(id);
  const next = { ...k, mac: prev?.mac };
  if (JSON.stringify(prev) !== JSON.stringify(next)) { known.set(id, next); saveKnown(); }
  if (!next.mac) void learnMac(id, k.host);
}
/** `arp -n` output -> "aa:bb:cc:dd:ee:ff". macOS drops leading zeros ("0:1a:..."), so pad them back. */
export function macFromArp(out: string): string | undefined {
  const m = out.match(/\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i);
  return m ? m[1].split(':').map((x) => x.padStart(2, '0')).join(':').toLowerCase() : undefined;
}
function learnMac(id: string, host: string): Promise<void> {
  return new Promise((resolve) => execFile('arp', ['-n', host], { timeout: 3000 }, (_e, out) => {
    const mac = macFromArp(String(out || '')); const k = known.get(id);
    if (mac && k && k.mac !== mac) { k.mac = mac; saveKnown(); log.info('renderer can be woken', { name: k.name, mac }); }
    resolve();
  }));
}
/** Wake-on-LAN: six 0xFF bytes, then the MAC sixteen times. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const m = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}
/** Directed broadcast of every LAN interface, plus the limited one. */
export function broadcasts(ifaces = os.networkInterfaces()): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(ifaces)) for (const i of list || []) {
    if (i.family !== 'IPv4' || i.internal || i.netmask === '255.255.255.255') continue;   // /32: a VPN like Tailscale, no LAN behind it
    const a = i.address.split('.').map(Number); const n = i.netmask.split('.').map(Number);
    out.add(a.map((x, k) => (x & n[k]) | (~n[k] & 255)).join('.'));
  }
  return [...out];
}
function sendWake(mac: string): Promise<void> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4'); const pkt = magicPacket(mac);
    s.on('error', (e) => { log.debug('wake packet failed', { err: e.message }); try { s.close(); } catch { /* ignore */ } resolve(); });
    s.bind(0, () => {
      s.setBroadcast(true);
      const to = broadcasts().flatMap((h) => [9, 7].map((port) => ({ h, port })));
      let left = to.length;
      for (const { h, port } of to) s.send(pkt, port, h, () => { if (--left === 0) { s.close(); resolve(); } });
    });
  });
}
/** At once, before any work: a 404 for a TV Kino never saw, a 503 for one that is off with no MAC to wake it by. */
function wakeable(id: string): void {
  if (renderers.has(id)) return;
  const k = known.get(id);
  if (!k) throw notFound();
  if (!k.mac) throw offNoMac(k);
}
/**
 * The renderer, awake. A TV that is off gets woken, then Kino waits up to 90 s for it to come back. Undefined at once
 * when `signal` calls off the cast that asked. A wake already running for this TV is waited on, not begun again.
 */
async function awake(id: string, signal?: AbortSignal): Promise<Renderer | undefined> {
  const r = renderers.get(id);
  if (r && !asleep(id)) return r;
  if (r && !wakes.has(id)) { try { await soap(r.avControl, AV, 'GetTransportInfo', {}, 2500, signal); misses.delete(id); return r; } catch { /* off, wake it */ } }
  const k = known.get(id);
  if (!k) throw notFound();
  if (!k.mac) throw offNoMac(k);
  if (signal?.aborted) return undefined;
  const w = wakes.get(id);
  return join(w && !w.stop.signal.aborted ? w : wakeUp(id, { ...k, mac: k.mac }), signal);   // one called off is on its way out
}

/** Begin waking a renderer: wake packets, a search, and a status check every 2 s, until it answers or 90 s pass. */
function wakeUp(id: string, k: Known & { mac: string }): Wake {
  const w: Wake = { done: Promise.resolve(undefined), waiters: 0, stop: new AbortController() };
  wakes.set(id, w); events.emit('receivers');
  const off = w.stop.signal;
  w.done = (async () => {
    log.info('waking renderer', { name: k.name, mac: k.mac });
    try {
      for (let i = 0, until = Date.now() + 90_000; Date.now() < until; i++) {
        if (off.aborted) { log.info('wake cancelled', { name: k.name }); return undefined; }
        if (i % 5 === 0) await io.wake(k.mac);   // again every 10 s: the network chip may still be napping
        search(); void describe(k.location, k.host);
        await io.wait(2000, off);
        const c = renderers.get(id);
        if (!c || off.aborted) continue;
        try { await soap(c.avControl, AV, 'GetTransportInfo', {}, 2500, off); } catch { continue; }
        misses.delete(id);
        log.info('renderer awake', { name: k.name, after: `${i * 2 + 2} s` });
        await io.wait(3000, off);   // DLNA answers before the TV's player is ready for a stream
        return off.aborted ? undefined : c;
      }
      throw httpError(503, `${k.name} did not turn on. Check that "Turn on via Wi-Fi" is on in the TV's settings.`);
    } finally {
      if (wakes.get(id) === w) wakes.delete(id);
      events.emit('receivers');
    }
  })();
  w.done.catch(() => undefined);
  return w;
}

/**
 * Wait on a wake as one of its casts: undefined at once when `signal` calls this one off. The wake stops (its 2 s wait cut
 * short, no more packets) once nobody waits, a turn of the event loop later, so a cast that replaces this one for the same
 * TV, and joins in the same turn, keeps it going.
 */
async function join(w: Wake, signal?: AbortSignal): Promise<Renderer | undefined> {
  w.waiters++;
  let leave = () => {};
  try {
    return await new Promise<Renderer | undefined>((resolve, reject) => {
      const off = () => resolve(undefined);
      if (signal?.aborted) { off(); return; }
      signal?.addEventListener('abort', off, { once: true });
      leave = () => signal?.removeEventListener('abort', off);
      w.done.then(resolve, reject);
    });
  } finally {
    leave();
    if (--w.waiters === 0) setImmediate(() => { if (w.waiters === 0) w.stop.abort(); });
  }
}


/** What a cast reaches outside this module, and its waits. Tests swap these for fakes. */
export const io = {
  /** The torrent's video file, after the disk check: a 507, a torrent that cannot be had, or a 400 for one with no video. */
  media: async (infoHash: string, fileIdx: number): Promise<{ t: Torrent; idx: number }> => {
    guard();
    const t = await ensure(infoHash);
    const idx = pickVideoFile(t, fileIdx >= 0 ? fileIdx : undefined);
    if (idx < 0) throw httpError(400, 'No video file in this torrent');
    return { t, idx };
  },
  probe,
  subtitles: listSubtitles,
  /** Wake-on-LAN, to every LAN broadcast address. */
  wake: sendWake,
  /** Turn an LG TV off over its own remote protocol (lg.ts). */
  powerOff: lg.turnOff,
  /** A pause, cut short when `signal` aborts. */
  wait: (ms: number, signal?: AbortSignal): Promise<void> => sleep(ms, undefined, { signal }).catch(() => undefined),
};

// ------------------------------------------------------------- discovery ----
async function describe(location: string, from: string): Promise<void> {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
    const xml = await res.text();
    if (!/MediaRenderer/i.test(xml)) return;
    const udn = tag(xml, 'UDN') || location;
    const name = tag(xml, 'friendlyName') || from;
    const model = [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' ') || 'DLNA renderer';
    const base = new URL(location);
    const service = (type: string) => { const m = xml.match(new RegExp(`<service>(?:(?!</service>)[\\s\\S])*?${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?</service>`, 'i')); const c = m && tag(m[0], 'controlURL'); return c ? new URL(c, base).toString() : ''; };
    const avControl = service(AV); const rcControl = service(RC);
    if (!avControl) return;
    const id = `dlna:${udn.replace(/^uuid:/, '')}`;
    const had = renderers.has(id);
    knownHosts.add(base.hostname);
    renderers.set(id, { kind: 'dlna', id, name, model, host: base.hostname, port: Number(base.port) || 80, audioOnly: false, location, avControl, rcControl, seenAt: Date.now() });
    misses.delete(id);
    know(id, { id, name, model, host: base.hostname, location });
    if (!had) log.info('renderer found', { name, model, host: base.hostname });
  } catch (e) { log.debug('describe failed', { location, err: errMsg(e) }); }
}

function search(): void {
  if (!sock) return;
  const msg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP}:1900`, 'MAN: "ssdp:discover"', 'MX: 3', 'ST: urn:schemas-upnp-org:device:MediaRenderer:1', '', ''].join('\r\n'));
  // UPnP says send it more than once: UDP drops, and TVs answer lazily. Known renderers also get it straight to their door.
  const send = () => { if (!sock) return; sock.send(msg, 1900, SSDP, () => undefined); for (const h of knownHosts) sock.send(msg, 1900, h, () => undefined); };
  send(); setTimeout(send, 300).unref(); setTimeout(send, 900).unref();
}

/** A NOTIFY or an M-SEARCH reply: either carries the description URL. */
function onSsdp(buf: Buffer, rinfo: dgram.RemoteInfo): void {
  const txt = buf.toString();
  if (!/MediaRenderer/i.test(txt) || /ssdp:byebye/i.test(txt)) return;
  const loc = txt.match(/^location:\s*(\S+)/im)?.[1];
  if (loc) void describe(loc, rinfo.address);
}

export function start(): void {
  loadAsked();
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => log.warn('ssdp socket error', { err: e.message }));
    sock.on('message', onSsdp);
    // The TV misses the first searches after a boot more often than not: retry quickly for the first minute.
    sock.bind(0, () => { for (const ms of [0, 1500, 5000, 12_000, 25_000, 45_000]) setTimeout(search, ms).unref(); });
    timer = setInterval(() => { search(); for (const [id, r] of renderers) if (Date.now() - r.seenAt > 10 * 60_000 && cur?.dev.id !== id) { renderers.delete(id); log.info('renderer gone', { name: r.name }); } }, 60_000);
    timer.unref();
    setInterval(() => void observe(), 4000).unref();
  } catch (e) { log.warn('ssdp unavailable', { err: errMsg(e) }); }
  // Second socket on the multicast group itself: a TV that turns on announces itself (NOTIFY ssdp:alive) without waiting to be asked.
  try {
    listener = dgram.createSocket({ type: 'udp4', reuseAddr: true }); // reusePort is ENOTSUP on macOS
    listener.on('error', (e) => { log.debug('ssdp listener error', { err: e.message }); listener = null; });
    listener.on('message', onSsdp);
    listener.bind(1900, () => { try { listener?.addMembership(SSDP, lanIp()); } catch (e) { log.debug('ssdp membership failed', { err: errMsg(e) }); } });
  } catch (e) { log.debug('ssdp listener unavailable', { err: errMsg(e) }); }
}
export function refresh(): void { search(); }
export function stopDiscovery(): void { if (timer) clearInterval(timer); try { sock?.close(); } catch { /* ignore */ } try { listener?.close(); } catch { /* ignore */ } sock = null; listener = null; }
export function devices(): CastDevice[] { return [...renderers.values()].map(({ kind, id, name, model, host, port, audioOnly }) => ({ kind, id, name, model, host, port, audioOnly })); }
export function get(id: string): Renderer | undefined { return renderers.get(id); }
/** Whether Kino can cast to this renderer: found over SSDP now, or remembered from before (a TV that is off, woken on cast). */
export const knows = (id: string): boolean => renderers.has(id) || known.has(id);
export const isDlnaId = (id: string) => id.startsWith('dlna:');

// --------------------------------------------------------------- session ----
interface Cur {
  dev: Renderer; req: CastPlayRequest; infoHash: string; fileIdx: number; fileName: string; duration: number; type: MediaType;
  tracks: SubtitleTrack[]; activeSubId?: string; subOffsetMs: number;
  state: CastStatus['state']; pos: number; volume: number; muted: boolean; lastSave: number; started: number; sawPlaying: boolean; poll?: NodeJS.Timeout; polling?: boolean;
  /** Loads of this session begun so far, and the newest one's end: a newer load waits for it, see reload(). */
  loads?: number; lastLoad?: Promise<void>;
}
let cur: Cur | null = null;
export const events = new EventEmitter();   // 'finished' -> { videoId, deviceId, subLang }; 'status' -> (state changed, republish)

function base(): string { return `http://${lanIp()}:${PORT}`; }
export function active(): boolean { return !!cur; }

export function status(): CastStatus {
  if (!cur) return { active: false };
  return {
    active: true, deviceId: cur.dev.id, deviceName: cur.dev.name, state: cur.state, currentTime: cur.pos, duration: cur.duration,
    volume: cur.volume, muted: cur.muted, activeSubId: cur.activeSubId, videoId: cur.req.videoId, title: cur.req.title, poster: cur.req.poster,
    infoHash: cur.infoHash, fileIdx: cur.fileIdx, mode: 'direct', timeOffset: 0, subOffsetMs: cur.subOffsetMs, type: cur.type, subs: cur.tracks,
  };
}
// The manager republishes this with the shared decoration (up next, stop after), so every status looks the same.
function publish(): void { events.emit('status'); }

/** What the Cast Center shows for a renderer, whether or not Kino is driving it. */
export function receiverInfo(id: string): ReceiverInfo | undefined {
  const r = renderers.get(id);
  if (!r || asleep(id)) {
    const k = known.get(id) || r; if (!k) return undefined;
    return { id, name: k.name, model: k.model, audioOnly: false, online: false, kind: 'dlna', kino: false, updatedAt: Date.now(), volume: 0, muted: false, asleep: true, canWake: !!known.get(id)?.mac, waking: wakes.has(id) };
  }
  const mine = cur?.dev.id === id;
  const o = mine ? undefined : seen.get(id);
  const other = o && o.state !== 'IDLE' ? o : undefined;
  return {
    id, name: r.name, model: r.model, audioOnly: false, online: true, kind: 'dlna', kino: mine, updatedAt: Date.now(), canPowerOff: lg.isLg(r),
    volume: mine ? cur!.volume : 0, muted: mine ? cur!.muted : false,
    app: mine ? { id: 'kino', name: 'Kino' } : other ? { id: 'dlna', name: 'Another app' } : undefined,
    media: mine ? { state: cur!.state || 'BUFFERING', title: cur!.req.title, artwork: cur!.req.poster, currentTime: cur!.pos, duration: cur!.duration }
      : other ? { state: other.state, title: other.title, currentTime: other.pos, duration: other.dur || undefined } : undefined,
  };
}
/**
 * The TV's power button. On: Wake-on-LAN, and the wake goes on in the background (up to 90 s) while the Cast Center shows
 * it turning on. Off: an LG TV over its own protocol (the TV asks you to allow Kino the first time); Kino's own stream
 * on it ends first, saved where it was.
 */
export async function power(id: string, on: boolean): Promise<void> {
  if (on) {
    if (renderers.has(id) && !asleep(id)) return;
    wakeable(id);
    void awake(id).catch((e) => log.warn('turning on failed', { err: errMsg(e) }));
    events.emit('receivers');
    return;
  }
  const r = renderers.get(id);
  if (!r) throw notFound();
  if (asleep(id)) return;
  if (!lg.isLg(r)) throw httpError(400, `Kino cannot turn ${r.name} off`);
  if (cur?.dev.id === id) await stop(false, 'stopped');
  await io.powerOff(r.host, id);
  log.info('turned off', { name: r.name });
  misses.set(id, 2);   // off now: show it so at once instead of after two missed polls
  seen.delete(id);
  events.emit('receivers');
}
export function receivers(): ReceiverInfo[] { return [...new Set([...renderers.keys(), ...known.keys()])].map((id) => receiverInfo(id)!).filter(Boolean); }

// --------------------------------------------------------------- observe ----
/*
 * The TV is asked what it is doing even when Kino is not driving it, so the Cast Center always
 * shows what is on. A stream of Kino's own that Kino lost track of (the TV answered Play after
 * the timeout, or the server restarted mid-episode) is taken back with full controls.
 */
interface Seen { state: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED'; uri?: string; title?: string; pos: number; dur: number }
const seen = new Map<string, Seen>();
/** The last casts asked for, per file: what taking one back needs (episode, title, subtitles). */
interface Asked { req: CastPlayRequest; duration: number; type: MediaType; tracks: SubtitleTrack[]; activeSubId?: string; subOffsetMs: number; fileName: string; at: number }
// Kept on disk: a deploy mid-episode must not turn the episode back into a nameless file.
const ASKED_FILE = path.join(DATA_DIR, 'dlna-asked.json');
/** How long a cast asked for is worth taking back. */
const ASKED_TTL = 12 * 3600_000;
const asked = new Map<string, Asked>();
/**
 * dlna-asked.json as start() loads it: the casts asked for in the last ASKED_TTL, their subtitle ids made to match this
 * install's secret.key (adoptSubId), as the store does for saved ones. An id from before ids were signed is re-signed, its
 * track's URL with it, or the TV would get a 404 for the subtitle; one that cannot be read goes, with its track.
 */
function freshAsked(raw: unknown, now = Date.now(), root?: Buffer): Map<string, Asked> {
  const out = new Map<string, Asked>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, a] of Object.entries(raw as Record<string, Partial<Asked> | null>)) {
    if (!a || typeof a !== 'object' || !a.req || typeof a.req !== 'object' || typeof a.at !== 'number' || !(now - a.at <= ASKED_TTL)) continue;
    const adopt = (id: unknown) => adoptSubId(id, root);
    const tracks = (Array.isArray(a.tracks) ? a.tracks : []).flatMap((t) => { const id = typeof t?.url === 'string' ? adopt(t.id) : undefined; return id ? [{ ...t, id, url: t.url.split(t.id).join(id) }] : []; });
    const { subId, ...req } = a.req;
    out.set(key, { ...a, req: typeof subId === 'string' ? { ...req, subId: adopt(subId) } : { ...req, subId }, tracks, activeSubId: adopt(a.activeSubId) } as Asked);
  }
  return out;
}
function saveAsked(): void { try { writeAtomic(ASKED_FILE, JSON.stringify(Object.fromEntries(asked))); } catch (e) { log.debug('could not save casts', { err: errMsg(e) }); } }
/** Read dlna-asked.json (freshAsked), and write it back when that dropped or re-signed anything. */
function loadAsked(file = ASKED_FILE, root?: Buffer): void {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  asked.clear();
  for (const [k, a] of freshAsked(raw, Date.now(), root)) asked.set(k, a);
  const text = JSON.stringify(Object.fromEntries(asked));
  if (text !== JSON.stringify(raw)) try { writeAtomic(file, text); } catch (e) { log.debug('could not save casts', { err: errMsg(e) }); }
}
function remember(key: string, a: Asked): void {
  for (const [k, v] of asked) if (Date.now() - v.at > ASKED_TTL) asked.delete(k);
  asked.set(key, a);
  saveAsked();
}
let observing = false;
/** No taking back while Kino itself is starting or stopping something: the TV still shows the old file for a moment. */
let quietUntil = 0;
const hush = (ms = 15_000) => { quietUntil = Math.max(quietUntil, Date.now() + ms); };
let adoptGuard: () => boolean = () => true;
/** The manager says no while a Chromecast session of Kino's is live: one session at a time. */
export function setAdoptGuard(fn: () => boolean): void { adoptGuard = fn; }

/** `.../api/file/<infoHash>/<idx>` -> the file, for any host: the TV may have been handed another LAN address. */
export function kinoFile(uri?: string): { infoHash: string; fileIdx: number } | undefined {
  const m = uri?.match(/\/api\/file\/([0-9a-f]{40})\/(\d+)(?:[?#]|$)/i);
  return m ? { infoHash: m[1].toLowerCase(), fileIdx: Number(m[2]) } : undefined;
}
export const stateOf = (st?: string): Seen['state'] => (st === 'PLAYING' ? 'PLAYING' : st === 'PAUSED_PLAYBACK' ? 'PAUSED' : st === 'TRANSITIONING' ? 'BUFFERING' : 'IDLE');
/** A title for something Kino did not start: the DIDL title, else the file name in the URL. */
export function seenTitle(meta?: string, uri?: string): string | undefined {
  const t = meta ? tag(meta, 'title') : undefined;
  if (t) return t;
  const last = uri?.split(/[?#]/)[0].split('/').filter(Boolean).pop();
  try { return last ? decodeURIComponent(last) : undefined; } catch { return last; }
}

async function ask(r: Renderer): Promise<Seen> {
  const [ti, mi, pi] = await Promise.all([soap(r.avControl, AV, 'GetTransportInfo', {}, 3000), soap(r.avControl, AV, 'GetMediaInfo', {}, 3000), soap(r.avControl, AV, 'GetPositionInfo', {}, 3000)]);
  const uri = tag(mi, 'CurrentURI') || undefined;
  return { state: stateOf(tag(ti, 'CurrentTransportState')), uri, title: seenTitle(tag(mi, 'CurrentURIMetaData'), uri), pos: secs(tag(pi, 'RelTime')), dur: secs(tag(pi, 'TrackDuration')) || secs(tag(mi, 'MediaDuration')) };
}

async function observe(): Promise<void> {
  if (observing) return;
  observing = true;
  try {
    await Promise.all([...renderers.values()].filter((r) => cur?.dev.id !== r.id).map(async (r) => {
      let next: Seen;
      try { next = await ask(r); } catch { const n = (misses.get(r.id) || 0) + 1; misses.set(r.id, n); if (seen.delete(r.id) || n === 2) events.emit('receivers'); return; }
      if (misses.delete(r.id)) events.emit('receivers');
      const prev = seen.get(r.id);
      seen.set(r.id, next);
      if (!prev || prev.state !== next.state || prev.title !== next.title || Math.abs(prev.pos - next.pos) > 5) events.emit('receivers');
      const f = kinoFile(next.uri);
      if (f && !cur && (next.state === 'PLAYING' || next.state === 'PAUSED') && Date.now() > quietUntil && adoptGuard()) adopt(r, f, next);
    }));
  } finally { observing = false; }
}

function adopt(dev: Renderer, f: { infoHash: string; fileIdx: number }, s: Seen): void {
  const a = asked.get(`${f.infoHash}:${f.fileIdx}`);
  const p = a ? undefined : Object.values(getState().progress).filter((x) => x.infoHash === f.infoHash && x.fileIdx === f.fileIdx).sort((x, y) => y.updatedAt - x.updatedAt)[0];
  const req: CastPlayRequest = a ? { ...a.req, deviceId: dev.id } : { deviceId: dev.id, infoHash: f.infoHash, fileIdx: f.fileIdx, videoId: p?.videoId, title: p?.name || s.title || 'Kino', poster: p?.poster };
  const c: Cur = {
    dev, req, infoHash: f.infoHash, fileIdx: f.fileIdx, fileName: a?.fileName || s.title || '', duration: a?.duration || s.dur, type: a?.type || p?.type || 'movie',
    tracks: a?.tracks || [], activeSubId: a?.activeSubId, subOffsetMs: a?.subOffsetMs || 0,
    state: s.state, pos: s.pos, volume: 0, muted: false, lastSave: 0, started: Date.now() - 20_000, sawPlaying: s.state === 'PLAYING',
  };
  cur = c;
  seen.delete(dev.id);
  arm(c);
  log.info('took back playback on renderer', { device: dev.name, title: req.title, videoId: req.videoId, pos: s.pos });
  publish();
  events.emit('receivers');
}

/** Pause, play, stop or seek whatever the TV is playing when it is not Kino's. */
export async function control(id: string, cmd: 'pause' | 'play' | 'stop' | 'seek', time = 0): Promise<void> {
  const r = renderers.get(id); if (!r) throw httpError(404, 'TV not found');
  if (cmd === 'pause') await soap(r.avControl, AV, 'Pause');
  else if (cmd === 'play') await soap(r.avControl, AV, 'Play', { Speed: '1' });
  else if (cmd === 'stop') { hush(); await soap(r.avControl, AV, 'Stop'); }
  else await soap(r.avControl, AV, 'Seek', { Unit: 'REL_TIME', Target: hms(time) });
  void observe();
}

/** After a timeout from the TV: is it playing our file anyway? LG answers Play late when it wakes its player. */
async function playingAnyway(c: Cur): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    try {
      const s = await ask(c.dev);
      const f = kinoFile(s.uri);
      if (f && f.infoHash === c.infoHash && f.fileIdx === c.fileIdx && s.state !== 'IDLE') return true;
    } catch { /* still busy */ }
    await io.wait(1000);
  }
  return false;
}

function persist(c: Cur, pos: number): void {
  if (!c.req.videoId || !(pos >= MIN_PROGRESS_SEC)) return;   // a renderer still at 0 is not a position
  const { metaId, season, episode } = parseVideoId(c.req.videoId);
  const existing = getProgress(c.req.videoId);
  saveProgress({ videoId: c.req.videoId, metaId, type: season != null ? 'series' : 'movie', pos, dur: c.duration || existing?.dur || 0, updatedAt: Date.now(), name: c.req.title, poster: c.req.poster || existing?.poster, background: existing?.background, season, episode, infoHash: c.infoHash, fileIdx: c.fileIdx });
}

function didl(c: Cur, url: string, mime: string, sub?: { url: string }): string {
  const res = `<res protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000">${esc(url)}</res>`;
  const cap = sub ? `<res protocolInfo="http-get:*:text/srt:*">${esc(sub.url)}</res><sec:CaptionInfoEx sec:type="srt">${esc(sub.url)}</sec:CaptionInfoEx><sec:CaptionInfo sec:type="srt">${esc(sub.url)}</sec:CaptionInfo>` : '';
  const art = c.req.poster ? `<upnp:albumArtURI>${esc(c.req.poster)}</upnp:albumArtURI>` : '';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/" xmlns:sec="http://www.sec.co.kr/"><item id="kino" parentID="0" restricted="1"><dc:title>${esc(c.req.title)}</dc:title><upnp:class>object.item.videoItem.movie</upnp:class>${art}${res}${cap}</item></DIDL-Lite>`;
}

/**
 * Hand the TV c's media and play it from startTime. False, with the steps after left out, once `still` says no (the
 * session was stopped or replaced, or a newer load of it began): a stale load never presses Play over a newer one.
 */
async function load(c: Cur, startTime: number, still: () => boolean): Promise<boolean> {
  const url = `${base()}/api/file/${c.infoHash}/${c.fileIdx}`;
  const mime = mimeFor(c.fileName);
  const sub = c.activeSubId ? c.tracks.find((t) => t.id === c.activeSubId) : undefined;
  const subUrl = sub ? `${base()}${sub.url.replace(/\.vtt$/, '.srt')}${c.subOffsetMs ? `?offset=${c.subOffsetMs}` : ''}` : undefined;
  // A TV waking its player from NO_MEDIA_PRESENT can sit on these for a while; be patient here, strict elsewhere.
  try { await soap(c.dev.avControl, AV, 'Stop', {}, 6000); } catch { /* nothing loaded */ }
  if (!still()) return false;
  await soap(c.dev.avControl, AV, 'SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: didl(c, url, mime, subUrl ? { url: subUrl } : undefined) }, 25_000);
  if (!still()) return false;
  await soap(c.dev.avControl, AV, 'Play', { Speed: '1' }, 25_000);
  if (startTime > 5) {
    // seek only once the renderer is actually playing, otherwise LG ignores it
    for (let i = 0; i < 20; i++) {
      await io.wait(500);
      if (!still()) return false;
      const st = tag(await soap(c.dev.avControl, AV, 'GetTransportInfo'), 'CurrentTransportState');
      if (!still()) return false;
      if (st === 'PLAYING') { try { await soap(c.dev.avControl, AV, 'Seek', { Unit: 'REL_TIME', Target: hms(startTime) }); } catch (e) { log.warn('seek failed', { err: errMsg(e) }); } break; }
      if (st === 'STOPPED' && i > 6) break;
    }
  }
  return still();
}

/** A ticket for one load of c: true while c is the session and no newer load of it has begun. */
function ticket(c: Cur): () => boolean { const n = c.loads = (c.loads || 0) + 1; return () => cur === c && c.loads === n; }
/**
 * Load c at `at()` once the load of c before this one has stopped at its next step, so the TV gets one load at a time
 * and the newest wins. True when this load finished and is still the newest; it throws only while it is.
 */
async function reload(c: Cur, at: () => number, still: () => boolean): Promise<boolean> {
  const before = c.lastLoad;
  const mine = (async () => { await before; return still() && await load(c, at(), still); })();
  c.lastLoad = mine.then(() => undefined, () => undefined);
  try { return await mine; }
  catch (e) { if (still()) throw e; log.debug('a load a newer one replaced failed', { err: errMsg(e) }); return false; }
}

/** Ask the TV every 2 s where it is, while c is the session. Re-arming replaces the running poll, so two reloads in a row leave one. */
function arm(c: Cur): void { if (c.poll) clearInterval(c.poll); c.poll = undefined; if (cur === c) { c.poll = setInterval(() => void poll(c), 2000); c.poll.unref(); } }

async function poll(c: Cur): Promise<void> {
  if (cur !== c) { if (c.poll) clearInterval(c.poll); c.poll = undefined; return; }   // a session that ended polls no more
  if (c.polling) return;   // a slow TV must not stack SOAP calls
  c.polling = true;
  try {
    const [ti, pi] = await Promise.all([soap(c.dev.avControl, AV, 'GetTransportInfo', {}, 4000), soap(c.dev.avControl, AV, 'GetPositionInfo', {}, 4000)]);
    const st = tag(ti, 'CurrentTransportState');
    const pos = secs(tag(pi, 'RelTime')); const dur = secs(tag(pi, 'TrackDuration'));
    if (dur > 0 && !c.duration) c.duration = dur;
    if (pos > 0 || st === 'PLAYING') c.pos = pos;
    const prev = c.state;
    c.state = st === 'PLAYING' ? 'PLAYING' : st === 'PAUSED_PLAYBACK' ? 'PAUSED' : st === 'TRANSITIONING' ? 'BUFFERING' : st === 'STOPPED' || st === 'NO_MEDIA_PRESENT' ? 'IDLE' : c.state;
    if (c.state === 'PLAYING') c.sawPlaying = true;
    if (prev !== c.state) { if (c.state === 'PLAYING') haEvent('play', { title: c.req.title, target: c.dev.name }); else if (c.state === 'PAUSED') haEvent('pause', { title: c.req.title, target: c.dev.name }); }
    if (c.req.videoId && c.state === 'PLAYING' && Date.now() - c.lastSave > 10_000) { c.lastSave = Date.now(); persist(c, c.pos); }
    if (c.dev.rcControl && Date.now() % 4 < 2) {
      try {
        const [v, m] = await Promise.all([soap(c.dev.rcControl, RC, 'GetVolume', { Channel: 'Master' }, 3000), soap(c.dev.rcControl, RC, 'GetMute', { Channel: 'Master' }, 3000)]);
        c.volume = Number(tag(v, 'CurrentVolume') || 0) / 100; c.muted = tag(m, 'CurrentMute') === '1';
      } catch { /* renderer without RC */ }
    }
    // Finished: the TV goes back to STOPPED after having played to (near) the end.
    if (c.state === 'IDLE' && c.sawPlaying && Date.now() - c.started > 15_000) {
      const done = c.duration > 0 && c.pos / c.duration > 0.96;
      log.info(done ? 'finished' : 'stopped on the TV', { videoId: c.req.videoId, pos: c.pos });
      if (c.req.videoId) persist(c, done ? c.duration : c.pos);
      const info = { videoId: c.req.videoId, deviceId: c.dev.id, subLang: c.tracks.find((t) => t.id === c.activeSubId)?.lang, subOffsetMs: c.subOffsetMs };
      await stop(false, done ? 'finished' : 'cancelled');
      if (done) events.emit('finished', info);
      return;
    }
    publish();
  } catch (e) { log.debug('poll failed', { err: errMsg(e) }); }
  finally { c.polling = false; }
}

type CastOpts = {
  preferLang?: string;
  /** The manager's word that a newer command took over (aborted when its castGen moves on). */
  signal?: AbortSignal;
  /** Ends what plays elsewhere (the manager's Chromecast cast), called once the TV answered: a wake that fails ends nothing. */
  takeOver?: () => Promise<void>;
};
/**
 * Cast a file to a renderer, waking it if it is off. `signal` is checked after every await until this cast is the
 * session: one that lost ends nothing, wakes no TV and loads nothing, however long the TV took to wake. Once it is the
 * session, the newer command stops it.
 */
export async function castTo(req: CastPlayRequest, opts: CastOpts = {}): Promise<CastStatus> {
  const done = new AbortController();   // this call's wait on the wake ends with it, however it ends: one nobody waits on stops
  try { return await castFile(req, opts, opts.signal ? AbortSignal.any([opts.signal, done.signal]) : done.signal); }
  finally { done.abort(); }
}
async function castFile(req: CastPlayRequest, opts: CastOpts, signal: AbortSignal): Promise<CastStatus> {
  const gone = () => signal.aborted;
  // The cheap checks first: a TV Kino cannot reach or wake, a full disk, a torrent that cannot be had or one with no
  // video in it wake no TV.
  wakeable(req.deviceId);
  // A wake already running for this TV, for the cast this one replaces: waited on from now, so it goes on.
  const early = wakes.has(req.deviceId) ? awake(req.deviceId, signal) : undefined;
  early?.catch(() => undefined);
  const { t, idx } = await io.media(req.infoHash, req.fileIdx);
  if (gone()) return status();
  const wake = early ?? awake(req.deviceId, signal);   // a TV that is off boots while ffprobe and the subtitle lookup run
  wake.catch(() => undefined);
  const local = `http://127.0.0.1:${PORT}/api/file/${t.infoHash}/${idx}`;
  let duration = 0;
  try { duration = (await io.probe(`${t.infoHash}:${idx}`, local)).duration; } catch (e) { log.warn('probe failed, continuing', { err: errMsg(e) }); }
  const type: MediaType = req.videoId?.includes(':') && !req.videoId.startsWith('magnet:') ? 'series' : 'movie';
  let tracks: SubtitleTrack[] = [];
  try { tracks = (await io.subtitles(type, req.videoId, t, idx)).filter((s) => s.available).slice(0, 30); } catch (e) { log.warn('subs failed', { err: errMsg(e) }); }
  if (gone()) return status();   // the wake heard it too, and stops unless another cast waits on it
  const saved = req.subId === undefined && req.videoId ? getProgress(req.videoId) : undefined;
  let activeSubId = req.subId && tracks.some((x) => x.id === req.subId) ? req.subId : undefined;
  if (!activeSubId && saved?.subId && tracks.some((x) => x.id === saved.subId)) activeSubId = saved.subId;
  if (!activeSubId && opts.preferLang && saved?.subId !== null) activeSubId = tracks.find((x) => x.lang === opts.preferLang)?.id;
  if (!activeSubId && saved?.subId && saved.subLang) activeSubId = tracks.find((x) => x.lang === saved.subLang)?.id;
  const activeTrack = tracks.find((x) => x.id === activeSubId);
  if (req.videoId && (req.subId !== undefined || activeTrack)) saveSubChoice(req.videoId, { subId: activeTrack?.id ?? null, subLang: activeTrack?.lang, subOffsetMs: req.subOffsetMs ?? saved?.subOffsetMs });
  const dev = await wake;
  if (!dev || gone()) return status();   // a 90 s wake must not take over from a newer command
  if (opts.takeOver) { await opts.takeOver(); if (gone()) return status(); }
  hush();
  if (cur) await stop(false);
  if (gone()) return status();
  const c: Cur = { dev, req, infoHash: t.infoHash, fileIdx: idx, fileName: t.files[idx].name, duration, type, tracks, activeSubId, subOffsetMs: req.subOffsetMs ?? saved?.subOffsetMs ?? 0, state: 'BUFFERING', pos: req.startTime || 0, volume: 0, muted: false, lastSave: 0, started: Date.now(), sawPlaying: false };
  cur = c;
  remember(`${c.infoHash}:${c.fileIdx}`, { req, duration, type, tracks, activeSubId, subOffsetMs: c.subOffsetMs, fileName: c.fileName, at: Date.now() });
  publish();
  const still = ticket(c);
  let loaded: boolean;
  try { loaded = await reload(c, () => req.startTime || 0, still); }
  catch (e) {
    const late = await playingAnyway(c);
    if (!still()) return status();
    if (!late) { cur = null; publish(); throw refusedLoad(dev, e); }
    log.warn('TV answered late but is playing', { device: dev.name, err: errMsg(e) });
    if ((req.startTime || 0) > 5) { try { await soap(c.dev.avControl, AV, 'Seek', { Unit: 'REL_TIME', Target: hms(req.startTime!) }); } catch (err) { log.warn('seek failed', { err: errMsg(err) }); } }
    loaded = true;
  }
  // Stopped or replaced while the TV loaded, or a subtitle picked meanwhile reloads it: no poll for this load, that one arms its own.
  if (!loaded || !still()) return status();
  if (req.videoId) persist(c, req.startTime || 0);
  arm(c);
  log.info('playing on renderer', { device: dev.name, file: t.files[idx].name, sub: tracks.find((x) => x.id === activeSubId)?.label });
  return status();
}

export async function pause(): Promise<void> { if (cur) { await soap(cur.dev.avControl, AV, 'Pause'); cur.state = 'PAUSED'; publish(); } }
export async function resume(): Promise<void> { if (cur) { await soap(cur.dev.avControl, AV, 'Play', { Speed: '1' }); cur.state = 'PLAYING'; publish(); } }
export async function seek(time: number): Promise<void> { if (cur) { await soap(cur.dev.avControl, AV, 'Seek', { Unit: 'REL_TIME', Target: hms(time) }); cur.pos = time; publish(); } }
export async function setVolume(id: string, v: { level?: number; muted?: boolean }): Promise<void> {
  const r = renderers.get(id);
  if (!r) throw httpError(404, 'TV not found');
  if (!r.rcControl) throw httpError(409, 'This TV has no volume control Kino can use');
  if (v.level != null) await soap(r.rcControl, RC, 'SetVolume', { Channel: 'Master', DesiredVolume: Math.round(Math.max(0, Math.min(1, v.level)) * 100) });
  if (v.muted != null) await soap(r.rcControl, RC, 'SetMute', { Channel: 'Master', DesiredMute: v.muted ? 1 : 0 });
  if (cur?.dev.id === id) { if (v.level != null) cur.volume = v.level; if (v.muted != null) cur.muted = v.muted; publish(); }
}
/**
 * Subtitles ride along in the DIDL metadata, so changing them means reloading the URI at the current position. Two
 * changes in a row: the later one wins, the earlier stops at its next step and resolves.
 */
export async function setSubtitle(subId: string | null, offsetMs?: number): Promise<void> {
  const c = cur; if (!c) return;
  c.activeSubId = subId && c.tracks.some((t) => t.id === subId) ? subId : undefined;
  if (offsetMs != null) c.subOffsetMs = offsetMs;
  if (c.req.videoId) saveSubChoice(c.req.videoId, { subId: c.activeSubId ?? null, subLang: c.tracks.find((t) => t.id === c.activeSubId)?.lang, subOffsetMs: c.subOffsetMs });
  if (c.poll) clearInterval(c.poll);   // the TV reports STOPPED while it reloads: that is no end of the film
  c.poll = undefined;
  const still = ticket(c);
  let done = false;
  // The poll comes back even when the reload throws: without it the session goes dead (no position, no up next).
  try { done = await reload(c, () => c.pos, still); } finally { if (still()) arm(c); }
  if (done) publish();
}
export async function stop(haNotify = true, reason = 'stopped'): Promise<void> {
  hush();
  const c = cur; cur = null;
  if (!c) { publish(); return; }
  if (c.poll) clearInterval(c.poll);
  if (c.req.videoId && c.sawPlaying && reason !== 'finished') persist(c, c.pos);
  if (haNotify) haEvent('stop', { title: c.req.title, target: c.dev.name, reason });
  try { await soap(c.dev.avControl, AV, 'Stop', {}, 5000); } catch { /* gone */ }
  publish();
}
export const _internal = { hms, secs, tag, esc, describe, renderers, known, asked, freshAsked, loadAsked };
export function handoffInfo(): { videoId?: string; pos: number; infoHash: string; fileIdx: number; title: string; poster?: string } | null {
  return cur ? { videoId: cur.req.videoId, pos: cur.pos, infoHash: cur.infoHash, fileIdx: cur.fileIdx, title: cur.req.title, poster: cur.req.poster } : null;
}
