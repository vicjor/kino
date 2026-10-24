/**
 * `bun run dev` runs this first. Its API binds PORT and vite proxies /api and /health to KINO_API_PORT, both 1234 by
 * default. When something already answers there (production under launchd, the desktop app, another dev server), the
 * dev API only waits for the port and the dev client quietly talks to that install and its data. So refuse, and point
 * at `bun run dev:iso`. KINO_DEV_ATTACH=1 skips the check, for when using the running Kino is the point.
 * Exits 0 to go on, 1 to refuse. Usage: node scripts/dev-guard.ts
 */

/** The ports `bun run dev` needs to itself: the one its API binds and the one vite proxies to. */
export const devPorts = (env: Record<string, string | undefined>): number[] =>
  [...new Set([Number(env.PORT || 1234), Number(env.KINO_API_PORT || 1234)])];

/** What answers GET /health on this port, in a few words, or null when nothing listens there. */
export async function answering(port: number, ms = 1500): Promise<string | null> {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(ms) });   // localhost, as vite's proxy target
    const h = (await r.json().catch(() => null)) as { version?: unknown; busy?: unknown } | null;
    return typeof h?.version === 'string' ? `Kino ${h.version}${h.busy === true ? ', someone is watching' : ''}` : `HTTP ${r.status}`;
  } catch (e) {
    // Refused: the port is free. Anything else (no answer in time, a reset) means something holds it.
    return (e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED' ? null : `no answer within ${ms} ms`;
  }
}

/** The refusal, for ports that answered: what is there, why dev will not start, and the two ways on. */
export function refusal(found: [port: number, what: string][]): string {
  return [
    `bun run dev: something already answers on ${found.map(([p, w]) => `:${p} (${w})`).join(' and ')}.`,
    'The dev API could not bind it, and the dev client would proxy to that install and its data.',
    'Run `bun run dev:iso` instead: API on :1299 with its own data in ~/kino-dev, client on :5174.',
    'To use the running one on purpose: KINO_DEV_ATTACH=1 bun run dev',
  ].join('\n');
}

if (import.meta.main && process.env.KINO_DEV_ATTACH !== '1') {
  const found = (await Promise.all(devPorts(process.env).map(async (p) => [p, await answering(p)] as const)))
    .filter((f): f is [number, string] => f[1] !== null);
  if (found.length) { console.error(refusal(found)); process.exit(1); }
}
