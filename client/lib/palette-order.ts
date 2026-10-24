/**
 * Command palette rows in the order they show: every group once, under one heading. Groups go by their best row,
 * rows within a group by their own score. Groups that tie go by name, so two of them never take turns.
 */
export function byGroup<T extends { group: string; score: number }>(rows: T[]): T[] {
  const best = new Map<string, number>();
  for (const r of rows) best.set(r.group, Math.max(best.get(r.group) ?? -Infinity, r.score));
  return [...rows].sort((a, b) => best.get(b.group)! - best.get(a.group)! || a.group.localeCompare(b.group) || b.score - a.score);
}
