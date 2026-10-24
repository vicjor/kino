/**
 * A release-year window for Browse: `from` and `to` inclusive, either open. Read from a query string (two four-digit
 * years, swapped if given backwards, anything else ignored) and matched against Cinemeta's year text ("2019",
 * "2019-", a span of two years: the first year counts).
 */
export interface Years { from?: number; to?: number }

const year = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1880 && n <= 2100 ? n : undefined;
};

export function readYears(from: unknown, to: unknown): Years | undefined {
  let f = year(from), t = year(to);
  if (f == null && t == null) return undefined;
  if (f != null && t != null && f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

export function inYears(text: string | undefined, r: Years | undefined): boolean {
  if (!r) return true;
  const y = Number(/\d{4}/.exec(text || '')?.[0]);
  if (!y) return false;
  return (r.from == null || y >= r.from) && (r.to == null || y <= r.to);
}

/** The window as TMDB release dates; never past today for "new", where a future date means not out yet. */
export function yearDates(r: Years, today: string): { since?: string; until?: string } {
  const until = r.to != null ? `${r.to}-12-31` : undefined;
  return { since: r.from != null ? `${r.from}-01-01` : undefined, until: until && until < today ? until : today };
}
