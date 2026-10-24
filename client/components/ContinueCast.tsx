import { useState } from 'react';
import type { Progress } from '../../server/types.js';
import { api } from '../lib/api';
import { resumePoint } from '../lib/progress';
import { sendToTv, useSingleTv, resumeNow, type Tv } from '../lib/cast-actions';
import { CastPicker } from './LazyOverlays';

/** Everything the server needs to put a remembered file on a device at the right position. */
export interface ContinueTarget { infoHash: string; fileIdx: number; videoId?: string; name: string; poster?: string; startTime: number }

/** Continue Watching entries remember their source; only those can go straight to a device. */
export function continueTarget(p: Progress): ContinueTarget | null {
  if (p.infoHash == null || p.fileIdx == null) return null;
  return { infoHash: p.infoHash, fileIdx: p.fileIdx, videoId: p.videoId, name: p.name, poster: p.poster, startTime: resumePoint(p) ?? 0 };
}

/**
 * "Continue on the TV" next to any Continue button. With exactly one TV online it goes straight there,
 * otherwise the cast picker opens. Returns the sheet to render and the single TV's name for the label.
 */
export function useContinueCast() {
  const only = useSingleTv();
  const [pending, setPending] = useState<ContinueTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (t: ContinueTarget, d: Tv) => {
    setBusy(true);
    const ok = await sendToTv(d, async (deviceId) => api.castPlay({ deviceId, infoHash: t.infoHash, fileIdx: t.fileIdx, videoId: t.videoId, title: t.name, poster: t.poster, startTime: await resumeNow(t.videoId, t.startTime) }), `Continuing on ${d.name}`);
    if (ok) setPending(null);
    setBusy(false);
  };
  const start = (t: ContinueTarget) => { if (only) void send(t, only); else setPending(t); };
  const sheet = pending ? <CastPicker onPick={(d) => void send(pending, d)} onClose={() => setPending(null)} busy={busy} /> : null;
  return { start, sheet, busy, tvName: only?.name ?? null, label: only ? `Continue on ${only.name}` : 'Continue on TV' };
}
