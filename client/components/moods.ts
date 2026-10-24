import type { BrowseSort, BrowseType } from '../../server/types.js';

/**
 * Moods: the question you actually have on a Tuesday night, mapped to a Browse page.
 * Each one is a genre shelf with a sort, nothing cleverer, so it always has something in it.
 */
export interface Mood { key: string; title: string; sub: string; type: BrowseType; genre?: string; sort?: BrowseSort; hue: number }

export const MOODS: Mood[] = [
  { key: 'laugh', title: 'Make me laugh', sub: 'Comedy', type: 'all', genre: 'Comedy', hue: 42 },
  { key: 'edge', title: 'Keep me on edge', sub: 'Thrillers', type: 'all', genre: 'Thriller', hue: 355 },
  { key: 'away', title: 'Take me somewhere else', sub: 'Science fiction and fantasy', type: 'all', genre: 'Sci-Fi', hue: 212 },
  { key: 'crime', title: 'Crooks and cops', sub: 'Crime', type: 'all', genre: 'Crime', hue: 28 },
  { key: 'true', title: 'True stories', sub: 'Documentaries', type: 'all', genre: 'Documentary', hue: 160 },
  { key: 'scare', title: 'Scare me', sub: 'Horror films', type: 'movie', genre: 'Horror', hue: 285 },
  { key: 'feel', title: 'Big feelings', sub: 'Romance', type: 'all', genre: 'Romance', hue: 330 },
  { key: 'family', title: 'Family night', sub: 'For everyone', type: 'all', genre: 'Family', hue: 95 },
  { key: 'best', title: 'The best ever made', sub: 'Highest rated', type: 'all', sort: 'rated', hue: 48 },
  { key: 'fresh', title: 'Fresh this year', sub: 'New releases', type: 'all', sort: 'new', hue: 190 },
];

export function browseUrl(type: BrowseType, opts: { genre?: string; sort?: BrowseSort; from?: number; to?: number } = {}): string {
  const qs = [opts.genre ? `genre=${encodeURIComponent(opts.genre)}` : '', opts.sort && opts.sort !== 'top' ? `sort=${opts.sort}` : '', opts.from != null ? `from=${opts.from}` : '', opts.to != null ? `to=${opts.to}` : ''].filter(Boolean).join('&');
  return `/browse/${type}${qs ? `?${qs}` : ''}`;
}
export const moodUrl = (m: Mood) => browseUrl(m.type, { genre: m.genre, sort: m.sort });

/** "Thriller series", "Top rated comedy movies", "New releases": the page title for a Browse route. */
export function browseTitle(type: BrowseType, genre?: string, sort: BrowseSort = 'top', years = ''): string {
  const what = (type === 'movie' ? 'movies' : type === 'series' ? 'series' : 'movies and series') + (years ? ` ${years}` : '');
  if (sort === 'rated') return `Top rated ${genre ? genre.toLowerCase() + ' ' : ''}${what}`;
  if (sort === 'new') return `New ${genre ? genre.toLowerCase() + ' ' : ''}${what}`;
  return genre ? `${genre} ${what}` : `Popular ${what}`;
}
