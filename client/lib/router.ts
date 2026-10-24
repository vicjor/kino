import { useSyncExternalStore } from 'react';

export interface Route { path: string; parts: string[]; query: URLSearchParams }

function parse(): Route {
  const h = location.hash.replace(/^#/, '') || '/';
  const [p, q = ''] = h.split('?');
  const parts = p.split('/').filter(Boolean);
  return { path: '/' + parts.join('/'), parts, query: new URLSearchParams(q) };
}
let current = parse();
const subs = new Set<() => void>();
/**
 * How the screen on show was reached: pushed (a tap deeper in, or browser Forward), popped (Back), or swapped in place
 * (a replace, a tab). Screens enter along it, so a page that came in from the right goes back out the way it came.
 */
export type NavKind = 'push' | 'pop' | 'none';
let kind: NavKind = 'none';
export const navKind = (): NavKind => kind;
// Every in-app entry carries its depth and the hash it was pushed from, so Back knows
// whether there is an app page behind it and a screen can step back instead of stacking a duplicate.
interface NavState { kino: number; prev?: string }
const navState = (): NavState | null => { const s = history.state as NavState | null; return s && typeof s.kino === 'number' ? s : null; };
if (!navState()) history.replaceState({ kino: 0 }, '', location.href);
/** The entry on screen, so an entry the browser made for a plain `<a href="#/...">` can be given its place after it. */
let here = { kino: navState()?.kino ?? 0, hash: location.hash || '#/' };
const emit = () => { current = parse(); here = { kino: navState()?.kino ?? 0, hash: location.hash || '#/' }; subs.forEach((f) => f()); };
// Every entry this module makes or visits already has a state, so one without is a fresh fragment
// navigation (a link like "See all"): it sits right after the page it was clicked on.
const adopt = () => { if (!navState()) history.replaceState({ kino: here.kino + 1, prev: here.hash } satisfies NavState, '', location.href); };
// After a leave() that stepped back, land on the exact hash asked for (a series may have moved on an episode).
let landOn: string | null = null;
// A history.back() in flight: a second Back (Esc held down, a double tap) before it lands would skip a page.
let stepping = false;
const onPop = () => {
  stepping = false;
  kind = (navState()?.kino ?? 0) < here.kino ? 'pop' : 'push';
  adopt();
  if (landOn) { const h = landOn; landOn = null; if (location.hash !== h) history.replaceState(history.state, '', h); }
  emit();
};
window.addEventListener('popstate', onPop);
// A fresh entry (a plain link) is a push; the hashchange that follows a popstate keeps the kind popstate set.
window.addEventListener('hashchange', () => { if (!navState()) kind = 'push'; adopt(); emit(); });
const stepBack = () => { if (stepping) return; stepping = true; window.setTimeout(() => { stepping = false; }, 1000); history.back(); };

export function useRoute(): Route {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current);
}
export function navigate(hash: string, replace = false, how: NavKind = replace ? 'none' : 'push'): void {
  const h = hash.startsWith('#') ? hash : '#' + hash;
  kind = how;
  const st = navState() || { kino: 0 };
  if (replace) history.replaceState(st, '', h);
  else history.pushState({ kino: st.kino + 1, prev: location.hash || '#/' } satisfies NavState, '', h);
  emit();
}
export function back(fallback = '/'): void {
  if (stepping) return;
  if ((navState()?.kino || 0) > 0) stepBack(); else navigate(fallback, true, 'pop');
}
/** Go to `hash`, stepping back when the page behind this one is the same screen, so history holds no duplicate. */
export function leaveTo(hash: string): void {
  const h = hash.startsWith('#') ? hash : '#' + hash;
  const st = navState();
  const path = (x: string) => x.split('?')[0];
  if (stepping) return;
  if (st && st.kino > 0 && st.prev && path(st.prev) === path(h)) { landOn = h; stepBack(); }
  else navigate(h, true);
}
export { titleUrl, playUrl, readPlayParams } from './urls';
export type { PlayParams } from './urls';
