/**
 * Whether the first-run walkthrough covers the screen. /welcome always shows it (the replay in Settings).
 * Otherwise only Home, and only while setup is not done: a deep link still opens what it points at, and an
 * install that finished setup (or whose settings have not arrived yet) never sees it on its own.
 * Home has no route parts at all (`#/` parses to []), so an empty first part counts as Home too.
 */
export function shouldShowWalkthrough(route: { parts: readonly string[] }, settings: { onboarded?: boolean } | null | undefined): boolean {
  if (!settings) return false;
  const [head = ''] = route.parts;
  if (head === 'welcome') return true;
  return settings.onboarded === false && head === '';
}
