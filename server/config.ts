import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Environment: every variable the server reads is read here, each with a line on what it does, and README
// "Configuration" lists the same set (test/config.test.ts compares the two). Constants are read once, when this module
// loads (the server imports it first); a variable tests change after import is a function, read on every call.

/** KINO_DATA: the data folder (state.json, cache, HLS segments, subtitles, secret.key). Default ~/kino-data. */
export const DATA_DIR = process.env.KINO_DATA || path.join(os.homedir(), 'kino-data');
/** PORT: the HTTP port. Default 1234. */
export const PORT = Number(process.env.PORT || 1234);
/** KINO_PLAIN_PORT: an extra listener that redirects to PORT, so a URL needs no :1234. 0 or empty turns it off. Default 80. */
export const PLAIN_PORT = Number(process.env.KINO_PLAIN_PORT ?? 80);
/** KINO_CLIENT_DIR: the built client to serve. Default the client folder next to the server's (dist/client in a build). */
export const CLIENT_DIR = process.env.KINO_CLIENT_DIR || path.resolve(import.meta.dirname, '../client');
/** KINO_LAN_IP: the address TVs and Chromecasts fetch media from, for when lanIp() picks the wrong interface. */
const LAN_IP = process.env.KINO_LAN_IP;
/** KINO_HOSTNAME: the name registered as <name>.local over dns-sd on macOS (mdns-name.ts). Default kino; empty or `off` turns it off. */
export const MDNS_NAME = process.env.KINO_HOSTNAME ?? 'kino';
/** KINO_HOSTS: more host names Kino answers to, comma-separated, as given (host.ts parses them). */
export const HOSTS = process.env.KINO_HOSTS;
/** KINO_PIN: the PIN that locks the app. Unset or empty: no lock. */
export const PIN = process.env.KINO_PIN;
/** KINO_NO_HW: set to anything to turn VideoToolbox hardware encoding off (media/hls.ts). */
export const NO_HW = !!process.env.KINO_NO_HW;
/** LOG_LEVEL: the lowest level logged: debug, info, warn or error. Default info. */
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
/** KINO_LOG_FILE: also append every log line to this file, rotated (log.ts). Unset: stdout and stderr only. */
export const LOG_FILE = process.env.KINO_LOG_FILE || undefined;
/** FFMPEG_BIN, FFPROBE_BIN: the ffmpeg or ffprobe to run, used as given (media/bins.ts). Read on every call: tests point them at fakes after import. */
export const binOverride = (name: 'ffmpeg' | 'ffprobe'): string | undefined => (name === 'ffmpeg' ? process.env.FFMPEG_BIN : process.env.FFPROBE_BIN) || undefined;

export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const HLS_DIR = path.join(DATA_DIR, 'hls');
export const SUBS_DIR = path.join(DATA_DIR, 'subs');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
/** Random key for signing ids Kino hands out (subtitle ids). Created on first use, mode 0600. */
export const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

/** Create the data folders. Called at boot (server/index.ts), so importing this module writes nothing. */
export function ensureDirs(): void { for (const d of [DATA_DIR, CACHE_DIR, HLS_DIR, SUBS_DIR]) fs.mkdirSync(d, { recursive: true }); }

// Kino ships with metadata and subtitle addons only. Stream addons are the user's choice, added in Settings.
export const DEFAULT_ADDONS = ['https://opensubtitles-v3.strem.io/manifest.json'];
export const CINEMETA = 'https://v3-cinemeta.strem.io';

type Iface = { name: string; addr: string };

/** Carrier-grade NAT block that Tailscale hands out (100.64.0.0/10). Nothing on the LAN can reach it. */
function isCgnat(addr: string): boolean { const [a, b] = addr.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; }

/** Rank candidate IPv4s: real LAN adapters first, VPN tunnels (utun, tun, wg, tailscale) last. Unknown names sit in between. */
export function pickLanIp(ifs: Iface[]): string | undefined {
  const prefer = ['en0', 'en1', 'eth0'];
  const rank = (i: Iface) => {
    const p = prefer.indexOf(i.name);
    if (p >= 0) return p;
    if (/^(utun|tun|wg|tailscale|ipsec|ppp)/.test(i.name) || isCgnat(i.addr)) return 100;
    return 50;
  };
  return [...ifs].sort((a, b) => rank(a) - rank(b))[0]?.addr;
}

/** LAN IPv4 the Chromecast and other devices can reach. KINO_LAN_IP overrides. */
export function lanIp(): string {
  if (LAN_IP) return LAN_IP;
  const all: Iface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) all.push({ name, addr: i.address });
  }
  return pickLanIp(all) || '127.0.0.1';
}

export const GB = 1024 ** 3;
export const DAY_MS = 86_400_000;

/** Inside an Electron app bundle, binaries live in app.asar.unpacked: fs reads through asar, spawn does not. */
export function unasar(p: string): string { return p.replace(/\.asar([\\/])/, '.asar.unpacked$1'); }
