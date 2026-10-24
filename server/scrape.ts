import Client, { type ScrapeData } from 'bittorrent-tracker';
import { TRACKERS } from './torrent.js';
import { TtlCache } from './http.js';
import { logger } from './log.js';

const log = logger('scrape');

/**
 * Seeders counted by Kino: one UDP scrape per public tracker, up to 70 info hashes a packet, the highest
 * `complete` any tracker reports per hash. Addons often pass on a stale or made-up figure (some providers
 * report one fixed placeholder for every release); the trackers answer with what is actually seeding right now. Cached ten minutes.
 */
const cache = new TtlCache<number>(10 * 60_000, 5000);
const BATCH = 70;
const WAIT_MS = 3000;        // the slowest tracker is not worth more than this
const ENOUGH_MS = 1200;      // after this, three answering trackers are a good enough picture
const ENOUGH = 3;
const UDP = TRACKERS.filter((t) => t.startsWith('udp://'));

/** One round of questions about up to BATCH hashes: the highest `complete` heard per hash. Never rejects. */
type Ask = (hashes: string[]) => Promise<Map<string, number>>;
let ask: Ask = askTrackers;
/** Tests only: answer in place of the public trackers, so no test ever reaches one. null puts the trackers back. */
export function setScrapeForTests(fn: Ask | null): void { ask = fn ?? askTrackers; }

/** Live seeder counts for the hashes not already cached; trackers that stay quiet are simply not counted. */
export async function scrapeSeeds(infoHashes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const todo: string[] = [];
  for (const h of new Set(infoHashes.map((x) => x.toLowerCase()))) { const c = cache.get(h); if (c != null) out.set(h, c); else todo.push(h); }
  if (!todo.length) return out;
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  await Promise.all(batches.map(async (b) => { for (const [h, n] of await ask(b)) { cache.set(h, n); out.set(h, n); } }));
  for (const h of todo) if (!out.has(h)) cache.set(h, -1);   // asked, nobody answered: do not ask again for a while
  return out;
}

function askTrackers(hashes: string[]): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const bufs = hashes.map((h) => Buffer.from(h, 'hex'));
    const best = new Map<string, number>();
    let client: Client | null = null;
    try { client = new Client({ infoHash: bufs[0], peerId: Buffer.from('-KI0001-' + Math.random().toString(36).slice(2, 14).padEnd(12, '0')), announce: UDP, port: 6881 }); }
    catch (e) { log.debug('scrape client failed', { err: String(e) }); resolve(best); return; }
    const seen = new Set<string>();
    const done = () => {
      clearTimeout(timer); clearTimeout(soft);
      try { client?.destroy(); } catch { /* ignore */ }
      resolve(best);
    };
    const started = Date.now();
    const timer = setTimeout(done, WAIT_MS);
    const soft = setTimeout(() => { if (seen.size >= ENOUGH) done(); }, ENOUGH_MS);
    client.on('scrape', (d: ScrapeData) => {
      const h = d.infoHash.toLowerCase();
      if (d.complete > (best.get(h) ?? -1)) best.set(h, d.complete);
      seen.add(d.announce);
      if (seen.size >= UDP.length || (seen.size >= ENOUGH && Date.now() - started >= ENOUGH_MS)) done();
    });
    client.on('error', () => undefined);
    client.on('warning', () => undefined);
    client.scrape({ infoHash: bufs });
  });
}
