/** "S2 E3": how Kino labels an episode everywhere, on cards, chips, the TV and in saved names. */
export function episodeCode(season: number, episode: number): string {
  return `S${season} E${episode}`;
}

/**
 * The one name an episode is saved and cast under: "Show S2 E3 Title", no title, no trailing space.
 * Continue watching, the history and the TV all show what was saved, and client/components/home-data.ts
 * splits it back on the "S2 E3". No imports: the client bundles this file too.
 */
export function episodeName(show: string | undefined, season: number, episode: number, title?: string): string {
  return [show?.trim(), episodeCode(season, episode), title?.trim()].filter(Boolean).join(' ');
}
