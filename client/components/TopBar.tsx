import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate, back } from '../lib/router';
import { IconBack, IconGear, IconHome } from './Icons';
import { Brand } from './Brand';

/**
 * A floating navigation bar. With a `title`, the page gets an iOS large title under the bar, the page's h1; once it has
 * scrolled up under the bar, the same words appear small and centred in the bar, so you always know where you are.
 */
export function TopBar({ children, backTo, title, right }: { children?: ReactNode; backTo?: string; title?: string; right?: ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  const big = useRef<HTMLHeadingElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const h = big.current, b = bar.current;
    if (!h || !b || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting), { rootMargin: `-${b.offsetHeight}px 0px 0px 0px` });
    io.observe(h);
    return () => io.disconnect();
  }, [title]);
  return (
    <>
      <header ref={bar} className={`topbar${collapsed ? ' collapsed' : ''}`}>
        {backTo !== undefined ? (
          <button className="iconbtn" aria-label="Back" onClick={() => back(backTo)}><IconBack /></button>
        ) : (
          <a className="wordmark" href="#/" aria-label="Kino home"><Brand /></a>
        )}
        {/* The h1 below says it to screen readers; this copy is only drawn. Wraps rather than ending in an ellipsis. */}
        {title ? <span className="topbar-title" aria-hidden="true">{title}</span> : null}
        {children}
        {!children ? <span className="spacer" /> : null}
        {right !== undefined ? right : (
          <>
            {backTo !== undefined ? <button className="iconbtn" aria-label="Home" onClick={() => navigate('/')}><IconHome /></button> : null}
            <button className="iconbtn" aria-label="Settings" onClick={() => navigate('/settings')}><IconGear /></button>
          </>
        )}
      </header>
      {title ? <h1 ref={big} className="large-title">{title}</h1> : null}
    </>
  );
}
