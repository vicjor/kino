import os from 'node:os';
import { Bonjour, type Service } from 'bonjour-service';
import { logger } from '../log.js';
import { discover as dnssdDiscover, isAudioOnly } from './dnssd.js';
import * as dlna from './dlna.js';
import type { CastDevice } from '../types.js';

const log = logger('cast.discovery');
const devices = new Map<string, CastDevice>();
const DARWIN = os.platform() === 'darwin';
let bonjour: Bonjour | null = null;
let browser: ReturnType<Bonjour['find']> | null = null;
let timer: NodeJS.Timeout | null = null;

// Devices are accumulated, never cleared on a single miss: a Chromecast often
// skips a browse window while always-on speakers answer every time. We run BOTH
// discovery paths on macOS and merge: bonjour-service works on Macs where a
// userland 5353 socket is allowed; dns-sd works via the system responder on the
// box where HA/zeroconf already own 5353. Whichever sees a device, we keep it.

function toDevice(s: Service): CastDevice | undefined {
  const txt = (s.txt || {}) as Record<string, string>;
  const id = txt.id || s.name;
  const v4 = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || (s as unknown as { referer?: { address?: string } }).referer?.address;
  if (!v4) return undefined;
  const model = txt.md || 'Unknown';
  return { id, name: txt.fn || s.name, model, host: v4, port: s.port || 8009, audioOnly: isAudioOnly(model) };
}

async function dnssdPass(): Promise<void> {
  try { for (const d of await dnssdDiscover()) devices.set(d.id, d); }
  catch (e) { log.warn('dns-sd pass failed', { err: String(e) }); }
}

function startBonjour(): void {
  try {
    bonjour = new Bonjour();
    browser = bonjour.find({ type: 'googlecast' });
    browser.on('up', (s: Service) => { const d = toDevice(s); if (d) { devices.set(d.id, d); log.info('found (bonjour)', { name: d.name, host: d.host }); } });
  } catch (e) { log.warn('bonjour unavailable', { err: String(e) }); }
}

export function start(): void {
  startBonjour();
  if (DARWIN) void dnssdPass();
  timer = setInterval(() => { if (DARWIN) void dnssdPass(); try { browser?.update(); } catch { /* ignore */ } }, 60_000);
  timer.unref();
}

export function refresh(): void { if (DARWIN) void dnssdPass(); try { browser?.update(); } catch { /* ignore */ } dlna.refresh(); }
/** Google Cast devices plus DLNA renderers (LG TV), TVs first. */
export function list(): CastDevice[] { return [...[...devices.values()].map((d) => ({ ...d, kind: 'cast' as const })), ...dlna.devices()].sort((a, b) => Number(a.audioOnly) - Number(b.audioOnly) || a.name.localeCompare(b.name)); }
export function get(id: string): CastDevice | undefined { return devices.get(id) || dlna.get(id); }
export function stop(): void { if (timer) clearInterval(timer); try { browser?.stop(); bonjour?.destroy(); } catch { /* ignore */ } bonjour = null; browser = null; }
