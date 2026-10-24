import type { AppState } from './store';
import { chordPending } from './keys';

/** Every sheet the player can open. Adding a sheet means adding it here, so no guard can forget one. */
export interface PlayerSheets { keys: boolean; subs: boolean; cast: boolean; sources: boolean; audio: boolean; sleep: boolean; stall: boolean; episodes: boolean }

/** Whether any sheet is open. A caller may pass only the sheets it has. */
export const anyPlayerSheet = (s: Partial<PlayerSheets>): boolean => Object.values(s).some(Boolean);

/** The app's own overlays, which sit over any screen: the Cast Center and the command palette. */
export type AppOverlays = Pick<AppState, 'ccOpen' | 'palOpen'>;

/** Who answers a key press in the player: nobody, the "?" that closes the shortcuts sheet, or the player's shortcuts. */
export type PlayerKeyRoute = 'ignore' | 'close-keys' | 'player';

interface KeyLike { key: string; defaultPrevented?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

/**
 * An open sheet owns the keyboard: Sheet closes the top one on Esc, and no key reaches the player behind it.
 * The Cast Center and the palette own it too, the same way (CastHotkeys steps aside for them as well).
 * A key something already handled (a sheet's Esc) is not the player's either, nor any key of a palette "g" chord:
 * "g l" opens the Library, it does not seek 10 s as well (chordPending, as CastHotkeys asks).
 * `tag` is the tag name of the element the key was pressed in; `app` is the store at press time.
 */
export function playerKeyRoute(e: KeyLike, tag: string | undefined, open: Partial<PlayerSheets>, app: AppOverlays): PlayerKeyRoute {
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return 'ignore';
  if (app.ccOpen || app.palOpen || chordPending(e)) return 'ignore';
  if (open.keys) return e.key === '?' ? 'close-keys' : 'ignore';
  return anyPlayerSheet(open) ? 'ignore' : 'player';
}
