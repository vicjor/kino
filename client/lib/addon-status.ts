import type { AddonRow } from './api';

/** Kino installs these by itself (server DEFAULT_ADDONS). Subtitles only, so one that is down never explains missing streams. */
export const BUNDLED_ADDONS = ['https://opensubtitles-v3.strem.io/manifest.json'];

/**
 * What Settings says about streams above the addon list. `down`: installed but not answering right now. `sure`: they are
 * known to serve streams (Kino skips them for a minute after they failed). Otherwise their manifest did not load, so
 * nobody can tell what they serve.
 */
export type StreamSource = { kind: 'ok' } | { kind: 'none' } | { kind: 'down'; names: string[]; sure: boolean };

const nameOf = (a: AddonRow) => (a.name || 'An addon').replace(/^https?:\/\//, '');

export function streamSource(addons: AddonRow[]): StreamSource {
  const streams = addons.filter((a) => a.ok && a.resources.includes('stream'));
  if (streams.some((a) => !a.skipped)) return { kind: 'ok' };
  if (streams.length) return { kind: 'down', names: streams.map(nameOf), sure: true };
  const down = addons.filter((a) => !a.ok && !BUNDLED_ADDONS.includes(a.url));
  return down.length ? { kind: 'down', names: down.map(nameOf), sure: false } : { kind: 'none' };
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The callout for `down`: names them, says what it means for playing, and that Kino asks again by itself. */
export function downCallout({ names, sure }: { names: string[]; sure: boolean }): { title: string; text: string } {
  const one = names.length === 1;
  const they = one ? 'It is' : 'They are';
  return {
    title: `${joinNames(names)} ${one ? 'is' : 'are'} not answering right now`,
    text: sure
      ? `${they} installed and serve${one ? 's' : ''} streams, but did not answer just now, so titles may show "No sources found" for a minute. Kino asks again by itself.`
      : `${they} installed, but did not answer just now, so Kino cannot tell what ${one ? 'it serves' : 'they serve'}. If ${one ? 'it is' : 'one of them is'} your stream addon, titles show "No sources found" until it answers again. Kino asks again by itself.`,
  };
}
