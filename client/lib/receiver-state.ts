import type { ReceiverInfo } from '../../server/types.js';

/** What a Cast Center tile shows a receiver doing. Also its CSS class (`.cc-state.<state>`), so it is one token. */
export type ReceiverState = 'waking' | 'off' | 'offline' | 'playing' | 'paused' | 'loading' | 'active' | 'idle';

export function receiverState(r: Pick<ReceiverInfo, 'waking' | 'asleep' | 'online' | 'media' | 'app'>): ReceiverState {
  if (r.waking) return 'waking';
  if (r.asleep) return 'off';
  if (!r.online) return 'offline';
  const m = r.media?.state;
  if (m === 'PLAYING') return 'playing';
  if (m === 'PAUSED') return 'paused';
  if (m === 'BUFFERING') return 'loading';
  return r.app ? 'active' : 'idle';
}

/** The words for each state. Copy only: the class comes from the state, never from these. */
export const RECEIVER_STATE_LABEL: Record<ReceiverState, string> = {
  waking: 'Turning on', off: 'Off', offline: 'Offline', playing: 'Playing', paused: 'Paused', loading: 'Loading', active: 'Active', idle: 'Idle',
};
