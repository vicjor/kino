import { spawn } from 'node:child_process';
import { logger } from '../log.js';
import type { CastDevice } from '../types.js';

const log = logger('cast.dnssd');

// macOS owns port 5353 via mDNSResponder, so a userland multicast-dns socket
// (bonjour-service) receives nothing here. dns-sd talks to the system responder,
// which works. dns-sd never exits on its own and there is no `timeout` binary on
// this box, so every call is bounded with a manual kill.
function run(args: string[], ms: number): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('dns-sd', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(out));
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, ms);
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

function unescape(s: string): string { return s.replace(/\\(.)/g, '$1'); }

/** Parse `key=val key=val` txt with backslash-escaped spaces. */
function parseTxt(line: string): Record<string, string> {
  const txt: Record<string, string> = {};
  const re = /(\w+)=((?:\\.|[^\\ ])*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.trim()))) txt[m[1]] = unescape(m[2]);
  return txt;
}

/**
 * Instance names from `dns-sd -B` output. Names are printed raw (spaces unescaped). Rmv lines are ignored:
 * discovery accumulates, and a device that really left fails its lookup anyway.
 */
export function parseBrowse(out: string): string[] {
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/\bAdd\b\s+\S+\s+\d+\s+local\.\s+_googlecast\._tcp\.\s+(.+?)\s*$/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

export interface Lookup { host: string; port: number; txt: Record<string, string> }

/** Host (no trailing dot), port and txt from `dns-sd -L` output; undefined until it says where the device is. */
export function parseLookup(out: string): Lookup | undefined {
  let host: string | undefined; let port = 8009; const txt: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const r = line.match(/can be reached at\s+(\S+?):(\d+)/);
    if (r) { host = r[1].replace(/\.$/, ''); port = Number(r[2]); }
    else if (/=/.test(line) && !/can be reached|Lookup|STARTING|DATE:/.test(line)) Object.assign(txt, parseTxt(line));
  }
  return host ? { host, port, txt } : undefined;
}

/** First IPv4 in `dns-sd -Gv4` output. An Add of 0.0.0.0 is how dns-sd says "no such record". */
export function parseResolve(out: string): string | undefined {
  for (const line of out.split('\n')) {
    const m = line.match(/\bAdd\b\s+\S+\s+\d+\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\b/);
    if (m && m[1] !== '0.0.0.0') return m[1];
  }
  return undefined;
}

/**
 * Speakers and speaker groups, not screens. Bonjour and dns-sd write the same device map, so both use this
 * one test; two tests made the flag depend on which pass ran last. Anything named Chromecast is a screen.
 */
export function isAudioOnly(model: string): boolean { return /group|audio|speaker|nest mini|home mini|google home|nest hub/i.test(model) && !/chromecast/i.test(model); }

export type Run = (args: string[], ms: number) => Promise<string>;
let pass: Promise<CastDevice[]> | null = null;

/**
 * Full discovery pass: browse, then resolve each device's host + txt to a CastDevice. One pass at a time:
 * `?refresh=1` and the 60 s timer would otherwise overlap, each spawning 1 + 2N dns-sd processes, so a
 * call while one runs gets that run's result. `exec` is for tests.
 */
export function discover(budgetMs = 4000, exec: Run = run): Promise<CastDevice[]> {
  return (pass ??= discoverOnce(budgetMs, exec).finally(() => { pass = null; }));
}

async function discoverOnce(budgetMs: number, exec: Run): Promise<CastDevice[]> {
  const instances = parseBrowse(await exec(['-B', '_googlecast._tcp', 'local.'], Math.min(budgetMs, 3500)));
  const devices = await Promise.all(instances.map(async (inst): Promise<CastDevice | undefined> => {
    const info = parseLookup(await exec(['-L', inst, '_googlecast._tcp', 'local.'], 2500));
    if (!info) return undefined;
    const ip = parseResolve(await exec(['-Gv4', info.host], 2500));
    if (!ip) return undefined;
    const txt = info.txt;
    const model = txt.md || 'Unknown';
    return { id: txt.id || inst, name: txt.fn || inst, model, host: ip, port: info.port, audioOnly: isAudioOnly(model) };
  }));
  const out = devices.filter((d): d is CastDevice => !!d);
  log.info('discovered', { count: out.length, names: out.map((d) => d.name) });
  return out;
}

export const _internal = { parseTxt };
