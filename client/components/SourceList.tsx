import { useMemo, useState } from 'react';
import type { Source, StreamsResponse } from '../../server/types.js';
import { fmtBytes } from '../lib/format';
import { IconPlay, IconCast, IconDownload, IconGear } from './Icons';
import { navigate } from '../lib/router';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { onlineTvs } from '../lib/tvs';
import { sourceTags, castFit } from './source-tags';

function Badges({ s }: { s: Source }) {
  return (
    <span className="badges">
      {s.resolution && s.resolution !== 'other' ? <span className="chip strong">{s.resolution === '2160p' ? '4K' : s.resolution}</span> : null}
      {s.hdr ? <span className="chip accent">{s.hdr}</span> : null}
      {s.codec === 'hevc' ? <span className="chip">HEVC</span> : s.codec === 'av1' ? <span className="chip">AV1</span> : s.codec === 'h264' ? <span className="chip">H.264</span> : null}
      {s.sourceTag ? <span className={`chip${/CAM|TS|TELESYNC|HDTS/i.test(s.sourceTag) ? ' warn' : ''}`}>{s.sourceTag}</span> : null}
      {s.audio ? <span className="chip">{s.audio}</span> : null}
      {s.group ? <span className="chip">{s.group}</span> : null}
    </span>
  );
}

const INITIAL = 10;
const SEEDS_HINT = 'This provider does not report seeders and the trackers did not answer for this one. The addon fills in the same number for every release, so Kino does not trust it.';
const LIVE_HINT = 'Counted by Kino on the public trackers just now.';
/** "seeds unknown" when the count is a provider placeholder, so one fixed number on every row does not pretend to be a measurement. */
function seedsLabel(s: Source): string { return s.seedersEstimated ? 'seeds unknown' : `${s.seeders} seeds`; }
function seedsTitle(s: Source): string | undefined { return s.seedersLive ? LIVE_HINT : s.seedersEstimated ? SEEDS_HINT : 'Seeders as reported by the addon.'; }

/**
 * One chip per TV on the network saying what it will do with this release: "Living · plays",
 * "LG TV · DTS may be silent". With no TV known yet, one generic Chromecast verdict.
 */
function FitChips({ s, tvs }: { s: Source; tvs: { id: string; name: string; kind?: 'cast' | 'dlna' }[] }) {
  const list = tvs.length ? tvs.map((tv) => ({ id: tv.id, name: tv.name, fit: castFit(s, tv.kind === 'dlna' ? 'dlna' : 'cast') })) : [{ id: 'tv', name: 'Chromecast', fit: castFit(s, 'cast') }];
  return (
    <span className="fits">
      {list.map((x) => <span key={x.id} className={`chip fit ${x.fit.ok}`} title={x.fit.why}><i />{x.name} · {x.fit.text}</span>)}
    </span>
  );
}

/**
 * Whole row is the play target. The cast button is the one secondary action and stops the click
 * from bubbling. Size gets its own column so the eye finds it without reading the badges.
 */
export function SourceList({ data, onPlay, onCast, onDownload, busyId }: { data: StreamsResponse; onPlay: (s: Source) => void; onCast?: (s: Source) => void; onDownload?: (s: Source) => void; busyId?: string }) {
  const [showAll, setShowAll] = useState(false);
  const cast = useStore((st) => st.cast);
  // Select the raw array and derive from it: a selector that filters returns a new array every time, and useSyncExternalStore then re-renders forever.
  const receivers = useStore((st) => st.receivers);
  const tvs = useMemo(() => onlineTvs(receivers), [receivers]);
  // The source the TV is playing right now, matched on torrent + file.
  const isPlaying = (s: Source) => !!cast.active && cast.infoHash === s.infoHash && (cast.fileIdx == null || s.fileIdx == null || cast.fileIdx === s.fileIdx);
  if (!data.sources.length) {
    if (!data.addonsQueried.length) {
      return (
        <div className="empty">
          <strong>No stream source installed yet</strong>
          Kino ships without one. Add a Stremio addon that serves streams and sources will show up here.
          <div className="empty-actions"><button className="btn" onClick={() => navigate('/settings')}><IconGear /> Add one in Settings</button></div>
        </div>
      );
    }
    return <div className="empty"><strong>No sources found</strong>{data.addonsFailed.length ? `Could not reach ${data.addonsFailed.join(', ')}.` : 'Try again in a moment, or add another addon in Settings.'}</div>;
  }
  const tags = sourceTags(data);
  // Every pick from a list goes to the local pick log (server/picks.ts), so the automatic pick can learn from it.
  const logPick = (s: Source, via: 'play' | 'cast') => { if (data.pickKey) void api.logPick(data.pickKey, s.id, via); };
  const shown = showAll ? data.sources : data.sources.slice(0, INITIAL);
  const hidden = data.sources.length - shown.length;
  return (
    <ul className="sources">
      {shown.map((s) => {
        const auto = s.id === data.auto;
        const busy = busyId === s.id;
        const playing = isPlaying(s);
        const size = fmtBytes(s.sizeBytes);
        const go = () => { if (busyId) return; logPick(s, 'play'); onPlay(s); };
        return (
          <li
            key={s.id}
            className={`source${auto ? ' auto' : ''}${busy ? ' busy' : ''}${playing ? ' playing' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`Play ${s.provider || s.addon}${size ? `, ${size}` : ''}`}
            aria-disabled={!!busyId && !busy}
            onClick={go}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }}
          >
            <span className="src-play" aria-hidden="true">{busy ? <span className="spinner tiny" /> : playing ? <span className="src-eq"><i /><i /><i /></span> : <IconPlay />}</span>
            <div className="src-main">
              <div className="src-line1">
                {playing ? <span className="chip live"><i />Playing on {cast.deviceName || 'TV'}</span> : null}
                {(tags.get(s.id) || []).map((t) => <span key={t} className={`chip ${t === 'Best pick' ? 'accent' : t === 'Best 4K' ? 'strong' : 'ok'}`}>{t}</span>)}
                <span className="src-provider">{s.provider || s.addon}</span>
                <span className="src-size-inline"><b>{size || 'Size unknown'}</b>{s.seeders != null ? <small title={seedsTitle(s)}> · {seedsLabel(s)}</small> : null}</span>
              </div>
              <div className="src-line2">
                <Badges s={s} />
              </div>
              <div className="src-name" title={s.releaseName}>{s.filename || s.releaseName}</div>
              {s.warnings.length ? <div className="src-warn">{s.warnings.join(' · ')}</div> : null}
              <FitChips s={s} tvs={tvs} />
            </div>
            <div className="src-size">
              <b>{size || 'Size unknown'}</b>
              {s.seeders != null ? <small title={seedsTitle(s)}>{seedsLabel(s)}</small> : null}
            </div>
            <div className="src-actions">
              {onDownload ? <button className="iconbtn" aria-label="Download for later" title="Download for later" disabled={!!busyId} onClick={(e) => { e.stopPropagation(); onDownload(s); }}><IconDownload /></button> : null}
              {onCast ? <button className="iconbtn" aria-label="Cast to a device" title="Cast" disabled={!!busyId} onClick={(e) => { e.stopPropagation(); logPick(s, 'cast'); onCast(s); }}><IconCast /></button> : null}
            </div>
          </li>
        );
      })}
      {hidden > 0 ? <li className="sources-more"><button className="btn ghost" onClick={() => setShowAll(true)}>Show {hidden} more sources</button></li> : null}
    </ul>
  );
}
