import type { TorrentStats as T } from '../../server/types.js';
import { fmtSpeed } from '../lib/format';
import { sharingNow } from '../lib/play-errors';

export function TorrentStats({ s }: { s: T | null }) {
  if (!s) return null;
  const pct = Math.round((s.progress || 0) * 100);
  return (
    <div className="tstats" aria-live="polite">
      <span>{sharingNow(s.numPeers)}</span>
      <span>{fmtSpeed(s.downloadSpeed)}</span>
      <span>{pct}% cached</span>
    </div>
  );
}
