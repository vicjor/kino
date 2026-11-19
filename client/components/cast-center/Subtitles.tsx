import { useState } from 'react';
import type { CastStatus, SubtitleTrack } from '../../../server/types.js';
import { langName, units } from '../../lib/format';

/**
 * Subtitle chips and the sync nudge for Kino's own cast. Mounted with the controller (renders nothing when
 * there is nothing to show), so "N more" stays open while the track list comes and goes.
 */
export function Subtitles({ show, cast, busy, sub }: { show: boolean; cast: CastStatus; busy: boolean; sub: (id: string | null, offsetMs?: number) => void }) {
  const [allSubs, setAllSubs] = useState(false);
  if (!show || !cast.subs?.length) return null;
  const subsAvail = cast.subs.filter((t) => t.available);
  // Several tracks per language is normal: keep the language, number the rest, star the hash match.
  const subLabel = (t: SubtitleTrack) => { const same = subsAvail.filter((x) => x.lang === t.lang); const n = same.indexOf(t) + 1; return `${langName(t.lang)}${same.length > 1 ? ` ${n}` : ''}${t.hashMatch ? ' ★' : ''}`; };
  return (
    <div className="cc-subs">
      <h3>Subtitles</h3>
      <div className="cc-subs-list">
        <button className={`cc-chip${!cast.activeSubId ? ' on' : ''}`} disabled={busy} onClick={() => sub(null)}>Off</button>
        {(allSubs ? subsAvail : subsAvail.slice(0, 11)).map((t) => (
          <button key={t.id} className={`cc-chip${cast.activeSubId === t.id ? ' on' : ''}`} disabled={busy} title={t.label} onClick={() => sub(t.id)}>{subLabel(t)}</button>
        ))}
        {!allSubs && subsAvail.length > 11 ? <button className="cc-chip more" onClick={() => setAllSubs(true)}>{subsAvail.length - 11} more</button> : null}
      </div>
      {cast.activeSubId ? (
        <div className="cc-sync">
          <span>Sync</span>
          <button className="cc-mini" disabled={busy} aria-label="Subtitles 0.1 seconds earlier" data-hint="Subtitles 0.1 seconds earlier" onClick={() => sub(cast.activeSubId || null, (cast.subOffsetMs || 0) - 100)}>−</button>
          <b>{units((cast.subOffsetMs || 0) / 1000, 'second', 1)}</b>
          <button className="cc-mini" disabled={busy} aria-label="Subtitles 0.1 seconds later" data-hint="Subtitles 0.1 seconds later" onClick={() => sub(cast.activeSubId || null, (cast.subOffsetMs || 0) + 100)}>+</button>
        </div>
      ) : null}
    </div>
  );
}
