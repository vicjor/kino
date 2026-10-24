import { useSyncExternalStore } from 'react';
import type { CastStatus, TorrentStats, Settings, ReceiverInfo, DownloadInfo } from '../../server/types.js';

interface Toast { id: number; text: string; kind: 'info' | 'error' }
export interface AppState {
  cast: CastStatus;
  stats: TorrentStats | null;
  settings: Settings | null;
  toasts: Toast[];
  online: boolean;
  ccOpen: boolean;
  /** Where the Cast Center should zoom out from (a widget or tile rect). Set before ccOpen. */
  ccOrigin?: { x: number; y: number; width: number; height: number } | null;
  /** The command palette (Cmd+K) is up. */
  palOpen: boolean;
  /** The artwork lighting the page (Ambient.tsx): Home's featured slide, a title's backdrop; null for none. */
  ambient?: string | null;
  receivers: ReceiverInfo[] | null;
  downloads: DownloadInfo[] | null;
  /** Device mirrored on the phone's lock screen (see LockRemote). */
  lockRemote: string | null;
  /** Server wants a PIN (KINO_PIN set) and this browser has none. */
  locked: boolean;
}
let state: AppState = { cast: { active: false }, stats: null, settings: null, toasts: [], online: true, ccOpen: false, palOpen: false, receivers: null, downloads: null, lockRemote: null, locked: false };
const subs = new Set<() => void>();

export function getStore(): AppState { return state; }
export function setStore(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
}
export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state));
}
let toastId = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * How long a toast stays: `ms` (3.5 s by default), errors at least 6 s, and long text long enough to read
 * (a second plus 20 characters a second, that part capped at 20 s).
 */
export function toastMs(text: string, kind: Toast['kind'], ms = 3500): number {
  return Math.max(ms, kind === 'error' ? 6000 : 0, Math.min(20000, 1000 + text.length * 50));
}

/** The list with `t` last. The same text already up leaves first, so it shows once and is read out again. */
export function withToast(list: Toast[], t: Toast): Toast[] {
  return [...list.filter((x) => x.text !== t.text), t];
}

/** Take a toast down now (a tap on it). */
export function dismissToast(id: number): void {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  setStore((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function toast(text: string, kind: Toast['kind'] = 'info', ms?: number): void {
  const id = ++toastId;
  for (const t of state.toasts) if (t.text === text) { clearTimeout(toastTimers.get(t.id)); toastTimers.delete(t.id); }
  setStore((s) => ({ toasts: withToast(s.toasts, { id, text, kind }) }));
  toastTimers.set(id, setTimeout(() => dismissToast(id), toastMs(text, kind, ms)));
}
