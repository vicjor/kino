import type { MetaPreview } from '../../server/types.js';

export type Kind = 'all' | 'movie' | 'series';
export type KindCounts = Record<Kind, number>;

/** How many titles of each kind a result set holds. */
export function kindCounts(results: readonly MetaPreview[]): KindCounts {
  const c: KindCounts = { all: results.length, movie: 0, series: 0 };
  for (const m of results) c[m.type]++;
  return c;
}

/** The chosen kind, or "all" once the results hold none of it: a new query never lands on a disabled tab over an empty grid. */
export const fitKind = (kind: Kind, counts: KindCounts): Kind => (counts[kind] ? kind : 'all');

/** The titles of one kind, or all of them. */
export const ofKind = (results: readonly MetaPreview[], kind: Kind): MetaPreview[] => results.filter((m) => kind === 'all' || m.type === kind);
