import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { startSleep, sleepLeft, keepSleep, keptSleep, type Sleep, type SleepChoice } from '../../lib/sleep';
import type { PlayParams } from '../../lib/router';
import type { Notice, ShowNotice } from './PlayerChrome';

/**
 * Sleep timer: pause at a wall-clock time or at the end of this episode (no auto-next). Each episode or source is
 * a new player: it starts with the timer the last one left, if that still applies here (keptSleep).
 */
export function useSleep(p: PlayParams, videoRef: RefObject<HTMLVideoElement | null>, showNotice: ShowNotice, setNotice: Dispatch<SetStateAction<Notice | null>>) {
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleep, setSleep] = useState<Sleep>(() => keptSleep(p));
  useEffect(() => { keepSleep(sleep, p); }, [sleep, p]);
  const [sleepMs, setSleepMs] = useState(0);   // left on a timed sleep, ticks once a second
  const sleepUntil = sleep && sleep !== 'episode' ? sleep.until : null;
  useEffect(() => {
    if (sleepUntil == null) { setSleepMs(0); return; }
    const tick = () => {
      const left = sleepUntil - Date.now();
      setSleepMs(Math.max(0, left));
      if (left <= 0) {
        setSleep(null);
        videoRef.current?.pause();
        showNotice({ text: 'Sleep timer: paused', action: { label: 'Keep watching', run: () => { setNotice(null); videoRef.current?.play().catch(() => undefined); } } }, 60_000);
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepUntil]);
  const pickSleep = (c: SleepChoice) => { const s = startSleep(c); setSleep(s); setSleepMs(sleepLeft(s)); setSleepOpen(false); };
  return { sleep, sleepMs, sleepOpen, setSleepOpen, pickSleep };
}
