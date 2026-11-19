import type { ReceiverCommand, ReceiverCommandBody } from '../../../server/types.js';

export const ZOOM_MS = 450;
export const ZOOM_OUT_MS = 280;
export type CmdFn = (id: string, c: ReceiverCommand, body?: ReceiverCommandBody) => Promise<void>;
/** A side sheet over the controller (rendered outside the zooming panel so `position: fixed` still means the viewport). */
export type SheetKind = null | 'sources' | 'keys';
