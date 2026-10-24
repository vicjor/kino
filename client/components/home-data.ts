import type { MetaPreview, Episode } from '../../server/types.js';

/** Names are stored as "Show S1 E5 Episode title". Split them back so the UI can style the parts. */
export function splitShowName(name: string): { show: string; episode: string } {
  const m = name.match(/^(.*?)\s+S\d+\s?E\d+\s*(.*)$/);
  return m ? { show: m[1], episode: m[2] } : { show: name, episode: '' };
}

/** Group new episodes per show, newest first, so one show with five new episodes is one stack, not five cards. */
export function groupNewEpisodes(items: { show: MetaPreview; episode: Episode }[]): { show: MetaPreview; episodes: Episode[] }[] {
  const by = new Map<string, { show: MetaPreview; episodes: Episode[] }>();
  for (const { show, episode } of items) {
    const g = by.get(show.id) || { show, episodes: [] };
    g.episodes.push(episode);
    by.set(show.id, g);
  }
  for (const g of by.values()) g.episodes.sort((a, b) => (b.season - a.season) || (b.episode - a.episode));
  return [...by.values()];
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** When an episode airs, the way you would say it: Today, Tomorrow, Wednesday, 7 Oct. Local calendar days. */
export function airLabel(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (isNaN(t)) return '';
  const d = new Date(t); const n = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
