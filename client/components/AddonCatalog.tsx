import { useEffect, useMemo, useState } from 'react';
import type { CatalogEntry, AddonInfo } from '../../server/types.js';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { Sheet } from './Sheet';
import { IconSearch, IconCheck, IconPlus } from './Icons';

const KIND: Record<CatalogEntry['kind'], string> = { streams: 'Streams', subtitles: 'Subtitles', both: 'Streams + subs' };

/**
 * At module scope so a re-render keeps each row (and the focus on its button) instead of remounting it.
 * Busy is aria-disabled, not disabled: browsers drop focus from a button the moment it turns disabled.
 */
function AddonRow({ a, busy, onToggle }: { a: CatalogEntry; busy: boolean; onToggle: (a: CatalogEntry) => void }) {
  return (
    <div className="row addon-row">
      <span className="grow">
        <span className="addon-name">{a.name}{a.note ? <span className="chip" style={{ marginLeft: 8 }}>{a.note}</span> : null}</span>
        <small>{a.description || KIND[a.kind]}</small>
        <small className="addon-kind">{KIND[a.kind]}{a.types.length ? ` · ${a.types.filter((t) => t === 'movie' || t === 'series' || t === 'anime').join(', ')}` : ''}</small>
      </span>
      <button className={`btn small${a.installed ? ' ghost' : ' primary'}`} aria-disabled={busy || undefined} style={busy ? { opacity: 0.45, cursor: 'default' } : undefined} onClick={() => { if (!busy) onToggle(a); }}>
        {a.installed ? <><IconCheck /> Added</> : <><IconPlus /> Add</>}
      </button>
    </div>
  );
}

/** Browse and install subtitle addons: a curated shortlist plus those in the Stremio community collection. Stream addons are never listed. */
export function AddonCatalog({ onClose, onChange }: { onClose: () => void; onChange: (a: AddonInfo[]) => void }) {
  const [items, setItems] = useState<CatalogEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.addonCatalog().then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const list = items || [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((a) => `${a.name} ${a.description} ${a.kind}`.toLowerCase().includes(s)) : list;
  }, [items, q]);
  const recommended = filtered.filter((a) => a.recommended || (a.installed && !q));
  const more = filtered.filter((a) => !recommended.includes(a));
  const shownMore = q || showAll ? more : more.slice(0, 12);

  const toggle = async (a: CatalogEntry) => {
    setBusy(a.url);
    try {
      if (a.installed) { await api.removeAddon(a.url); toast(`Removed ${a.name}`); }
      else { const r = await api.addAddon(a.url); toast(r.ok ? `Added ${r.name}` : `Added, but: ${r.error}`); }
      setItems((l) => (l || []).map((x) => (x.url === a.url ? { ...x, installed: !a.installed } : x)));
      onChange(await api.addons());
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(null); }
  };

  return (
    <Sheet title="Subtitle addons" onClose={onClose}>
      <p className="hint">Tap Add and it is live on the next title you open. These are independent third-party services. Stream addons are not listed here: paste the manifest URL of one you use in Settings.</p>
      <label className="search" style={{ maxWidth: 'none', margin: '4px 0 8px' }}>
        <IconSearch />
        <input type="search" placeholder="Search addons" value={q} onChange={(e) => setQ(e.target.value)} autoCorrect="off" autoCapitalize="off" />
      </label>
      {err ? <div className="err">{err} <button className="btn small" onClick={load}>Retry</button></div> : null}
      {!items && !err ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
      {recommended.length ? <><h3 className="addon-h">Recommended</h3>{recommended.map((a) => <AddonRow key={a.url} a={a} busy={busy === a.url} onToggle={toggle} />)}</> : null}
      {shownMore.length ? <><h3 className="addon-h">More from the community</h3>{shownMore.map((a) => <AddonRow key={a.url} a={a} busy={busy === a.url} onToggle={toggle} />)}</> : null}
      {!q && !showAll && more.length > shownMore.length ? <div className="sheet-actions" style={{ justifyContent: 'center' }}><button className="btn ghost small" onClick={() => setShowAll(true)}>Show {more.length - shownMore.length} more</button></div> : null}
      {items && !filtered.length ? <div className="empty">Nothing matches. You can still paste any manifest URL below the list in Settings.</div> : null}
    </Sheet>
  );
}
