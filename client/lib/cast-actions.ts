import type { CastDevice, CastStatus, ReceiverInfo } from '../../server/types.js';
import { api } from './api';
import { navigate, playUrl } from './router';
import { handoffPlayParams } from './handoff';
import { getStore, useStore, toast } from './store';
import { isTouch } from './player-caps';
import { singleTv } from './tvs';
import { resumePoint } from './progress';
import { toggleLockRemote, lockRemoteSupported } from '../components/LockRemote';

/** Where to send: a device from the picker or a receiver from the live list. The server only needs the id. */
export type Tv = Pick<CastDevice, 'id' | 'name'>;

/**
 * Lock-screen remote on for this device, on a phone or tablet. Safe to call again: unlike toggleLockRemote it
 * never switches the remote off. Call it inside the tap, before any await: iOS only starts audio from a gesture.
 */
function armLockRemote(deviceId: string): void {
  if (isTouch && lockRemoteSupported && getStore().lockRemote !== deviceId) toggleLockRemote(deviceId);
}

/**
 * Send something to a TV like every cast button does: lock-screen remote first (still inside the tap), then
 * `start` asks the server to play, then `done` as a toast. Never throws: a failure is an error toast and false.
 */
export async function sendToTv(tv: Tv, start: (deviceId: string) => Promise<unknown>, done: string): Promise<boolean> {
  try {
    armLockRemote(tv.id);
    await start(tv.id);
    toast(done);
    return true;
  } catch (e) { toast((e as Error).message, 'error', 6000); return false; }
}

/**
 * Where a title starts on a TV, asked at the tap. A page open since before the last watch (a cast that ended while
 * paused, the phone locked meanwhile) holds an old position, often none: the TV would start over. `stale` when offline.
 */
export async function resumeNow(videoId: string | undefined, stale = 0): Promise<number> {
  if (!videoId) return stale;
  const p = await api.progress(videoId).catch(() => undefined);
  return p === undefined ? stale : resumePoint(p) ?? 0;
}

/** The only TV online, or null: one TV gets it straight away, none or several open the picker. */
export const useSingleTv = (): ReceiverInfo | null => useStore((s) => singleTv(s.receivers));

/**
 * "Play here": stop the TV and carry on on this screen, where the TV was. When the TV had already stopped there is nothing to take over: a toast says so, and false.
 */
export async function handoffHere(cast: CastStatus): Promise<boolean> {
  const h = await api.castHandoff();
  if (!h) { toast('Nothing to pick up: the TV already stopped'); return false; }
  navigate(playUrl(handoffPlayParams(cast.type, h)));
  return true;
}
