import { createRoot } from 'react-dom/client';
// First, before App pulls in Home and its component sheets: equal selectors in those then win over the generic
// ones here (.spot-close sizes itself, not .iconbtn), whatever order the chunks arrive in.
import './styles/global.css';
import { App } from './App';
import { installTilt } from './lib/tilt';
import { isMacApp } from './lib/shell';

// Screens and hls.js load on demand. A tab left open across a deploy asks for chunk names
// that no longer exist; reload once to pick up the new build instead of showing a blank screen.
window.addEventListener('vite:preloadError', (e) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem('kino.chunkReload') || 0); sessionStorage.setItem('kino.chunkReload', String(Date.now())); } catch { /* private mode */ }
  if (Date.now() - last > 10_000) { e.preventDefault(); location.reload(); }
});

// iOS Safari only applies :active to a press when some touchstart listener exists. Press feedback lands on touch
// down, so every button answers the finger at once instead of on release.
document.addEventListener('touchstart', () => undefined, { passive: true });
installTilt();

// Kino.app on a Mac: the traffic lights cover the top left corner (global.css makes room), except in full screen,
// where macOS hides them.
if (isMacApp(navigator.userAgent)) {
  const mark = () => document.documentElement.classList.toggle('mac-app', !(innerWidth === screen.width && innerHeight === screen.height));
  mark();
  addEventListener('resize', mark);
}

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}
