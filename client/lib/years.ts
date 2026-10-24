/** Release-year windows for Browse: the quick picks, reading them from the URL, and saying them in words. */
export interface Years { from?: number; to?: number }
export interface YearPick extends Years { key: string; label: string }

export function yearPicks(now = new Date()): YearPick[] {
  const y = now.getFullYear();
  return [
    { key: 'this', label: 'This year', from: y, to: y },
    { key: 'last', label: 'Last year', from: y - 1, to: y - 1 },
    { key: 'recent', label: 'Last 5 years', from: y - 4, to: y },
    { key: '2020s', label: '2020s', from: 2020, to: 2029 },
    { key: '2010s', label: '2010s', from: 2010, to: 2019 },
    { key: '2000s', label: '2000s', from: 2000, to: 2009 },
    { key: '1990s', label: '1990s', from: 1990, to: 1999 },
    { key: 'older', label: 'Before 1990', to: 1989 },
  ];
}

const year = (v: string | null): number | undefined => {
  const n = Number(v);
  return v && Number.isInteger(n) && n >= 1880 && n <= 2100 ? n : undefined;
};

/** `from` and `to` from a Browse URL, swapped when backwards; undefined when neither is a year. */
export function readYears(q: URLSearchParams): Years | undefined {
  let from = year(q.get('from')), to = year(q.get('to'));
  if (from == null && to == null) return undefined;
  if (from != null && to != null && from > to) [from, to] = [to, from];
  return { from, to };
}

export const sameYears = (a: Years | undefined, b: Years | undefined): boolean => (a?.from ?? null) === (b?.from ?? null) && (a?.to ?? null) === (b?.to ?? null);

/** "from 2025", "from the 2010s", "from 2020 to 2024", "since 2015", "before 1990": tacked onto the page title. */
export function yearsPhrase(r: Years | undefined): string {
  if (!r || (r.from == null && r.to == null)) return '';
  const { from, to } = r;
  if (from != null && to != null) {
    if (from === to) return `from ${from}`;
    if (from % 10 === 0 && to === from + 9) return `from the ${from}s`;
    return `from ${from} to ${to}`;
  }
  return from != null ? `since ${from}` : `before ${(to as number) + 1}`;
}
