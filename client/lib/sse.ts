import { setStore, toast } from './store';
import type { Events } from '../../server/types.js';

/** The app's one connection to /api/events. Screens listen on it with onSse, never with an EventSource of their own. */
let es: EventSource | null = null;
let retry = 1000;
let started = false;

type Name = keyof Events;
const listeners = new Map<Name, Set<(data: never) => void>>();

/** Hand one event's JSON to everyone listening for it. A payload that does not parse goes nowhere. */
function deliver(name: Name, raw: string): void {
  let data: never;
  try { data = JSON.parse(raw) as never; } catch { return; }
  for (const cb of [...(listeners.get(name) ?? [])]) { try { cb(data); } catch { /* one listener's failure is not the others' */ } }
}
const bind = (src: EventSource, name: Name) => src.addEventListener(name, (e) => deliver(name, (e as MessageEvent).data));

/**
 * Listen to one server event, typed by its name, across reconnects. Returns the way to stop. Fine before
 * startSse: on a deep link the screen mounts (and listens) before App starts the connection.
 */
export function onSse<K extends Name>(name: K, cb: (data: Events[K]) => void): () => void {
  let set = listeners.get(name);
  if (!set) { set = new Set(); listeners.set(name, set); if (es) bind(es, name); }
  set.add(cb as (data: never) => void);
  return () => { set.delete(cb as (data: never) => void); };
}

function connect(): void {
  if (es) return;
  const src = es = new EventSource('/api/events');
  for (const name of listeners.keys()) bind(src, name);
  src.addEventListener('server.restart', () => { setStore({ online: false }); toast('Kino is restarting, back in a few seconds'); });
  src.onopen = () => { retry = 1000; setStore({ online: true }); };
  src.onerror = () => {
    setStore({ online: false });
    src.close(); if (es === src) es = null;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

/** Open the connection (App, once) with the store's own listeners: cast state, receivers, downloads, torrent stats. */
export function startSse(): void {
  if (!started) {
    started = true;
    onSse('cast.status', (cast) => setStore({ cast }));
    onSse('cast.receivers', (receivers) => setStore({ receivers }));
    onSse('downloads', (downloads) => setStore({ downloads }));
    onSse('torrent.stats', (stats) => setStore({ stats }));
  }
  connect();
}
