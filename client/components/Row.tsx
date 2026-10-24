import type { ReactNode } from 'react';
import { IconChevron } from './Icons';

/**
 * One rail. `sub` says why the rail is here ("You watched 8 episodes"), `href` continues it on a Browse page (the title links).
 * `more` is free-form for the rails that link elsewhere.
 */
export function Row({ title, children, wide, more, empty, sub, href }: { title: string; children: ReactNode; wide?: boolean; more?: ReactNode; empty?: string; sub?: string; href?: string }) {
  const count = Array.isArray(children) ? children.filter(Boolean).length : children ? 1 : 0;
  if (!count && !empty) return null;
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">
          {/* A rail that continues somewhere: the title itself is the link, with a chevron, as in the Apple TV app. */}
          {href ? <a className="section-link" href={href}><h2>{title}<IconChevron size={20} /></h2></a> : <h2>{title}</h2>}
          {sub ? <div className="section-sub">{sub}</div> : null}
        </div>
        {more ? <span className="more">{more}</span> : null}
      </div>
      {count ? <div className={`rail${wide ? ' wide' : ''}`}>{children}</div> : <div className="empty inline">{empty}</div>}
    </section>
  );
}
