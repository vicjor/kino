import type { Response } from 'express';
import { logger } from './log.js';
import type { Events } from './types.js';

const log = logger('events');
const clients = new Set<Response>();

/**
 * How much may wait unsent for one client. A phone asleep with the page open stops reading and every event
 * would pile up in this process: past this the stream is dropped, and the page reconnects when it wakes.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Write to one client, dropping it when it is gone or has fallen MAX_BUFFERED_BYTES behind. */
function write(res: Response, chunk: string): void {
  if (res.destroyed || res.writableEnded) { clients.delete(res); return; }
  res.write(chunk);
  if ((res.writableLength ?? 0) <= MAX_BUFFERED_BYTES) return;
  clients.delete(res);
  log.warn('event stream dropped, the client stopped reading', { buffered: res.writableLength });
  res.destroy();   // end() would still hold the buffer until the client read it
}

export function addClient(res: Response): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': hello\n\n');
  clients.add(res);
  for (const fn of onConnect) { try { fn(res); } catch { /* ignore */ } }
  const ping = setInterval(() => write(res, ': ping\n\n'), 20_000);
  res.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function emit<K extends keyof Events>(name: K, data: Events[K]): void {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) write(c, payload);
}

export function clientCount(): number { return clients.size; }

/** Last words before a restart: clients switch to "reconnecting" instead of failing on the first broken request. */
export function announceShutdown(): void { for (const c of clients) { try { c.write('event: server.restart\ndata: {}\n\n'); c.end(); } catch { /* gone */ } } clients.clear(); }

/** Send one event to a single client (initial snapshots on connect). */
export function send<K extends keyof Events>(res: Response, name: K, data: Events[K]): void {
  write(res, `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
const onConnect: ((res: Response) => void)[] = [];
export function onClientConnect(fn: (res: Response) => void): void { onConnect.push(fn); }
