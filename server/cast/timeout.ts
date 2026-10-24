/**
 * Settle like `p`, or reject once `ms` pass with an Error naming `label`. The timer is cleared either way.
 * castv2-client requests never time out and are never failed when the socket closes, so every awaited
 * Chromecast call goes through this or a route can hang forever.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}
