/** Everything Tab can stop on. Hidden elements (no layout box) are skipped by `tabbables`. */
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** The Tab stops inside `root`, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

/**
 * Keep Tab inside a dialog with `n` stops while focus sits on stop `i` (-1: on the dialog itself or nowhere).
 * Returns the stop to move to, -1 for the dialog itself when it has none, or null to let the browser move.
 */
export function tabWrap(i: number, n: number, back: boolean): number | null {
  if (n === 0) return -1;
  if (back) return i <= 0 ? n - 1 : null;
  return i < 0 || i >= n - 1 ? 0 : null;
}

/** Put focus back where it was before an overlay took it, unless the element is gone or focus has already moved on. */
export function restoreFocus(to: Element | null, from: HTMLElement | null): void {
  if (!(to instanceof HTMLElement) || to === document.body || !to.isConnected) return;
  const a = document.activeElement;
  if (a && a !== document.body && !from?.contains(a)) return;
  to.focus({ preventScroll: true });
}
