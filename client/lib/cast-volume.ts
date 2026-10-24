import type { CastStatus, ReceiverInfo } from '../../server/types.js';
import { api } from './api';
import { setStore } from './store';

/**
 * The TV's volume, the one the volume controls set. On a Chromecast the cast status carries the media stream's
 * own volume (100 % while the TV sits at 30 %), so read the device's receiver entry and fall back to the status
 * only when there is none.
 */
export interface TvVolume { level: number; muted: boolean; receiverId?: string; unknown?: boolean }
export type VolumeChange = { level?: number; muted?: boolean };

/**
 * A DLNA TV that answers 0 and not muted is not telling its volume: the LG says so while it plays with sound. Its
 * controls hide rather than show a muted 0, and a step from that 0 would set a quiet 5 %.
 */
export const volumeUnknown = (r: Pick<ReceiverInfo, 'kind' | 'volume' | 'muted'>): boolean => r.kind === 'dlna' && r.volume === 0 && !r.muted;

export function tvVolume(cast: Pick<CastStatus, 'deviceId' | 'volume' | 'muted'>, receivers: readonly ReceiverInfo[] | null | undefined): TvVolume {
  const dev = cast.deviceId ? (receivers || []).find((r) => r.id === cast.deviceId) : undefined;
  if (!dev) return { level: cast.volume ?? 1, muted: !!cast.muted };
  return { level: dev.volume, muted: dev.muted, receiverId: dev.id, ...(volumeUnknown(dev) ? { unknown: true } : {}) };
}

/** One step up or down, kept within 0 to 1 and snapped to 5 %. */
export function stepVolume(level: number, d: number): number { return Math.round(Math.min(1, Math.max(0, level + d)) * 20) / 20; }

/** The receiver list with one device's volume already changed, so a second key press builds on the first. */
export function withVolume(receivers: readonly ReceiverInfo[] | null | undefined, id: string, b: VolumeChange): ReceiverInfo[] | null {
  if (!receivers) return null;
  return receivers.map((r) => (r.id === id ? { ...r, volume: b.level ?? r.volume, muted: b.muted ?? r.muted } : r));
}

/** Set the TV's volume through the receiver when Kino knows it, else through the cast session. */
export function setTvVolume(tv: TvVolume, b: VolumeChange): Promise<unknown> {
  const id = tv.receiverId;
  if (!id) return api.castVolume(b).then((c) => setStore({ cast: c }));
  setStore((s) => ({ receivers: withVolume(s.receivers, id, b) }));
  return api.castReceiverCmd(id, 'volume', b).catch((e) => {
    api.castReceivers().then((r) => setStore({ receivers: r })).catch(() => undefined);   // undo the guess
    throw e;
  });
}
