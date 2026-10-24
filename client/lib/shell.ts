/** Kino.app on a Mac: Electron with the title bar hidden, so the window's traffic lights sit over the page's top left corner. */
export const isMacApp = (ua: string): boolean => /\bElectron\//.test(ua) && /\bMacintosh\b/.test(ua);
