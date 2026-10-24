/** How a scripted scroll moves: a jump when the system asks for reduced motion, else smooth. `match` is there for tests. */
export function scrollBehavior(match: (query: string) => { matches: boolean } = (q) => window.matchMedia(q)): ScrollBehavior {
  return match('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
