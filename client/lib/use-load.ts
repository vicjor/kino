import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useStore } from './store';

/**
 * One fetch as a screen shows it: the last good data (null before any arrives), the last error ('' once a load
 * succeeds or you retry), and whether a load is on its way. A failed refresh keeps the data: a screen shows its
 * error only while it has nothing else to show, so a dropped request never blanks what you were looking at.
 */
export interface LoadState<T> { data: T | null; error: string; loading: boolean }
type Next<T> = T | null | ((d: T | null) => T | null);
type LoadEvent<T> = { type: 'start'; clear: boolean } | { type: 'ok'; data: T } | { type: 'fail'; error: string } | { type: 'set'; data: Next<T> };

/** The state after one event. `start` with clear is a retry: the error goes while the new attempt runs. `set` is a local edit. */
export function loadStep<T>(s: LoadState<T>, e: LoadEvent<T>): LoadState<T> {
  switch (e.type) {
    case 'start': return { ...s, loading: true, error: e.clear ? '' : s.error };
    case 'ok': return { data: e.data, error: '', loading: false };
    case 'fail': return { ...s, error: e.error, loading: false };
    case 'set': return { ...s, data: typeof e.data === 'function' ? (e.data as (d: T | null) => T | null)(s.data) : e.data };
  }
}

/** What a failed load says. Never '': an empty error would read as no error. */
export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : typeof e === 'string' ? e : '') || 'Could not load this.';
}

/** Kino came back (the live connection reopened) after a load failed: time to try again. */
export function backOnline(was: boolean, now: boolean, failed: boolean): boolean { return !was && now && failed; }

/** Tickets for loads in flight: only the newest one's answer counts, and none once stopped (the screen went away). */
export function latest() {
  let n = 0, stopped = false;
  return { next: () => ++n, counts: (t: number) => !stopped && t === n, stop: () => { stopped = true; } };
}

/**
 * Loads once on mount, again when the page comes back into view (unless `visible: false`) and when Kino is reachable
 * again after a failed load. `reload` keeps the error up while it tries, `retry` clears it first (a Try again button
 * whose screen shows the spinner meanwhile). `setData` edits the data in place, as a screen does after a save.
 * `initial` paints at once (the last answer from the api cache) while the first load runs.
 */
export function useLoad<T>(load: () => Promise<T>, opts: { initial?: () => T | null | undefined; visible?: boolean } = {}) {
  const [state, dispatch] = useReducer(loadStep<T>, undefined, (): LoadState<T> => ({ data: opts.initial?.() ?? null, error: '', loading: true }));
  const fn = useRef(load);
  fn.current = load;   // the newest closure: a screen's fetch may read props or state
  const tickets = useRef(latest());
  const run = useCallback((clear: boolean) => {
    const t = tickets.current, mine = t.next();
    dispatch({ type: 'start', clear });
    fn.current().then((data) => { if (t.counts(mine)) dispatch({ type: 'ok', data }); }, (e) => { if (t.counts(mine)) dispatch({ type: 'fail', error: errorText(e) }); });
  }, []);
  const reload = useCallback(() => run(false), [run]);
  const retry = useCallback(() => run(true), [run]);
  const setData = useCallback((data: Next<T>) => dispatch({ type: 'set', data }), []);

  const visible = opts.visible ?? true;
  useEffect(() => {
    const t = latest();
    tickets.current = t;
    run(false);
    const onVis = () => { if (document.visibilityState === 'visible') run(false); };
    if (visible) document.addEventListener('visibilitychange', onVis);
    return () => { t.stop(); document.removeEventListener('visibilitychange', onVis); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const online = useStore((s) => s.online);
  const was = useRef(online);
  useEffect(() => { if (backOnline(was.current, online, !!state.error)) run(false); was.current = online; }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, reload, retry, setData };
}
