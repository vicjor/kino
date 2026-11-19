import { useEffect } from 'react';
import { isTouch } from '../../lib/player-caps';
import { castKeyAction, type CastKey } from '../../lib/cast-keys';

/**
 * The player's keys, aimed at the TV in the controller. `handle` returns false when the key does not apply right
 * now, which leaves the press alone. Nothing listens while `off` (a sheet is up, a command is on its way).
 */
export function useControllerKeys(off: boolean, handle: (a: CastKey) => boolean | void): void {
  useEffect(() => {
    if (isTouch) return;
    const onKey = (e: KeyboardEvent) => {
      if (off || (e.target as HTMLElement).tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = castKeyAction(e);
      if (a && handle(a) !== false) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // every render: the handlers close over live state and are cheap to rebind
}
