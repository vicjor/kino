import { project } from './spring';

/**
 * The page a let-go lands on: where the flick would carry the track (Apple's projection, at a scroll view's fast rate),
 * at most one page from where the drag began, as a paging scroll view does. `offset` is the track's x (0 or negative).
 */
export function pageAfter(offset: number, width: number, velocity: number, from: number, count: number): number {
  const p = Math.round(-(offset + project(velocity, 0.99)) / width);
  return Math.max(0, Math.min(count - 1, Math.max(from - 1, Math.min(from + 1, p))));
}
