import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { logger, errMsg } from './log.js';
import { PORT, MDNS_NAME, lanIp } from './config.js';

const log = logger('mdns');

// `dns-sd -P` asks the system mDNSResponder to answer for an extra hostname on
// this machine, so phones and TVs on the LAN can open http://kino.local
// instead of remembering an IP. No sudo, no port 5353 of our own (Home
// Assistant already owns it here). macOS only: Linux would need avahi.
// KINO_HOSTNAME picks the name ("kino" by default), "off" disables it.
const NAME = MDNS_NAME.trim().replace(/\.local$/i, '');
const enabled = process.platform === 'darwin' && !!NAME && NAME !== 'off';

let proc: ChildProcess | null = null;
let active = false;

/** The registered hostname, or null when the name is off or not (yet) active. */
export function hostname(): string | null { return active ? `${NAME}.local` : null; }

/**
 * dns-sd children outlive a server that died without its shutdown handler (kill -9, a crashed
 * tsx watch). They pile up and keep re-registering the name. Reap the ones nobody owns any more.
 */
function reapOrphans(host: string): number {
  let n = 0;
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || m[2] !== '1' || !/dns-sd -P /.test(m[3]) || !m[3].includes(` ${host} `)) continue;
      try { process.kill(Number(m[1])); n++; } catch { /* already gone */ }
    }
  } catch (e) { log.debug('orphan sweep failed', { err: errMsg(e) }); }
  if (n) log.info('reaped orphaned dns-sd', { n });
  return n;
}

export function start(): void {
  if (!enabled || proc) return;
  const host = `${NAME}.local`;
  const ip = lanIp();
  reapOrphans(host);
  // A shell keeps dns-sd on a leash: it dies with this process even when we never get to stop().
  const script = 'dns-sd "$@" & c=$!; trap \'kill $c 2>/dev/null\' TERM INT EXIT; while kill -0 $PPID 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 3; done';
  proc = spawn('/bin/sh', ['-c', script, 'kino-dns-sd', '-P', 'Kino', '_http._tcp', 'local', String(PORT), host, ip], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout?.on('data', (d: Buffer) => {
    if (!active && /record .* registered and active/i.test(d.toString())) { active = true; log.info('name registered', { url: `http://${host}`, port: PORT, ip }); }
  });
  proc.on('error', (e) => { log.warn('dns-sd unavailable', { err: e.message }); proc = null; });
  proc.on('exit', (code, sig) => { if (proc) log.warn('dns-sd exited', { code, sig }); proc = null; active = false; });
}

export function stop(): void {
  const p = proc;
  proc = null; active = false;
  try { p?.kill(); } catch { /* gone */ }
}
