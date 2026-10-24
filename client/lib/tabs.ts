import type { KeyboardEvent } from 'react';

/**
 * Arrow keys in a row of `n` tabs with tab `i` focused (the WAI-ARIA tabs pattern): Left and Right wrap,
 * Home and End jump to either end. The tab to move to, or null for a key the row leaves alone.
 */
export function tabMove(key: string, i: number, n: number): number | null {
  if (n <= 0 || i < 0 || i >= n) return null;
  switch (key) {
    case 'ArrowRight': return (i + 1) % n;
    case 'ArrowLeft': return (i - 1 + n) % n;
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

/**
 * onKeyDown for a role=tablist: moves focus to the next tab and picks it (selection follows focus). The key
 * stops here, or the window's cast keys would also seek the TV on the same arrow.
 */
export function onTabKeys(e: KeyboardEvent<HTMLElement>, pick: (i: number) => void): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const to = tabMove(e.key, tabs.indexOf(e.target as HTMLElement), tabs.length);
  if (to == null) return;
  e.preventDefault(); e.stopPropagation();
  tabs[to].focus();
  pick(to);
}
