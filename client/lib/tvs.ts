import type { ReceiverInfo } from '../../server/types.js';

/** Every receiver but the speakers: the Cast controls show TVs only, as the pickers do. */
export const tvsOnly = (receivers: readonly ReceiverInfo[] | null | undefined): ReceiverInfo[] => (receivers || []).filter((r) => !r.audioOnly);

/** Receivers that can show a film right now: online and not a speaker. */
export const onlineTvs = (receivers: readonly ReceiverInfo[] | null | undefined): ReceiverInfo[] => (receivers || []).filter((r) => r.online && !r.audioOnly);

/**
 * The TV to send to without asking: the only one online, else null (none, or several to pick from).
 * Returns the entry itself, never a copy, so it is a stable store selector.
 */
export function singleTv(receivers: readonly ReceiverInfo[] | null | undefined): ReceiverInfo | null {
  const tvs = onlineTvs(receivers);
  return tvs.length === 1 ? tvs[0] : null;
}
