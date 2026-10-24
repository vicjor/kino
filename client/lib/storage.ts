import { fmtBytes } from './format';

/** What the Storage bar needs from /api/disk. downloadBytes is missing on an older server. */
type Disk = { cacheBytes: number; cacheCapBytes: number; downloadBytes?: number };

/**
 * The Storage bar in Settings: segment widths in percent (downloads saved for later, then the rest of the cache) and
 * its words. Downloads count toward the cache limit but are never evicted or cleared, so on their own they can pass
 * it: the bar then spans everything cached, never past 100%, and the words say the downloads are beyond the limit.
 */
export function storageBar(d: Disk): { saved: number; cached: number; used: string; savedLine?: string } {
  const total = Math.max(0, d.cacheBytes), cap = Math.max(0, d.cacheCapBytes);
  const saved = Math.min(total, Math.max(0, d.downloadBytes ?? 0)), rest = total - saved;
  const span = Math.max(1, cap, total);
  const pct = (n: number) => Math.round((n / span) * 1000) / 10;
  const capText = fmtBytes(cap) || '0 MB';
  const over = saved > cap;
  return {
    saved: pct(saved), cached: Math.max(0, Math.round((pct(total) - pct(saved)) * 10) / 10),
    used: over ? `Other cached data: ${fmtBytes(rest) || 'none'}` : `${fmtBytes(total) || '0 MB'} of ${capText} cache used`,
    savedLine: !saved ? undefined
      : over ? `Saved for later: ${fmtBytes(saved)}, beyond the ${capText} cache limit`
      : `Saved for later: ${fmtBytes(saved)}, kept when you clear the cache`,
  };
}
