import type { SubtitleTrack } from '../../server/types.js';
import { langName } from '../lib/format';
import { Sheet } from './Sheet';
import { isTouch } from '../lib/player-caps';

export function SubtitleMenu({ tracks, active, offsetMs, size, loading, applying, title, onPick, onOffset, onSize, onAuto, autoBusy, onClose }: {
  tracks: SubtitleTrack[]; active?: string; offsetMs: number; size?: number; loading: boolean; applying?: boolean; title?: string;
  onPick: (t: SubtitleTrack | null) => void; onOffset: (ms: number) => void; onSize?: (pct: number) => void; onAuto?: () => void; autoBusy?: boolean; onClose: () => void;
}) {
  const groups = new Map<string, SubtitleTrack[]>();
  for (const t of tracks) { const k = t.lang || 'und'; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t); }
  // On a phone the drawer covers the video: pick and get out of the way. The
  // track keeps loading in the background. Desktop keeps it open for comparing.
  const pick = (t: SubtitleTrack | null) => { onPick(t); if (isTouch) onClose(); };
  return (
    <Sheet title={title || 'Subtitles'} onClose={onClose} side>
      <div className="sub-tools">
        <div className="sub-tool">
          <span>Sync</span>
          <button className="btn small" disabled={!active} onClick={() => onOffset(offsetMs - 100)}>−0.1 s</button>
          <strong>{(offsetMs / 1000).toFixed(1)} s</strong>
          <button className="btn small" disabled={!active} onClick={() => onOffset(offsetMs + 100)}>+0.1 s</button>
          {onAuto ? <button className="btn small primary" disabled={!active || autoBusy} onClick={onAuto} title="Listen to the audio and line the subtitles up">{autoBusy ? <span className="spinner sm" /> : 'Auto'}</button> : null}
        </div>
        {onSize && size != null ? (
          <div className="sub-tool">
            <span>Size</span>
            <button className="btn small" onClick={() => onSize(Math.max(70, size - 10))}>A−</button>
            <strong>{size}%</strong>
            <button className="btn small" onClick={() => onSize(Math.min(180, size + 10))}>A+</button>
          </div>
        ) : null}
      </div>
      <button className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => pick(null)}>
        <span className="grow">Off</span>{!active ? <span className="chip accent">On</span> : null}
      </button>
      {loading ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
      {!loading && !tracks.length ? <div className="empty"><strong>No subtitles found</strong>Try another source, or add a language in Settings.</div> : null}
      {[...groups.entries()].map(([lang, list]) => (
        <div key={lang} className="sub-group">
          <h3>{langName(lang)}</h3>
          {list.map((t) => (
            <button key={t.id} className="row" style={{ width: '100%', textAlign: 'left' }} disabled={!t.available} onClick={() => pick(t)}>
              <span className="grow">{t.label}{t.hashMatch ? ' ★' : ''}{t.recommended && !t.hashMatch ? <span className="chip ok" style={{ marginLeft: 8 }}>Best</span> : null}<small>{t.origin === 'opensubtitles' ? 'OpenSubtitles' : t.origin === 'embedded' ? (t.available ? 'In the video file' : 'In the video file · ready when fully downloaded') : t.origin === 'torrent' ? 'In the torrent' : t.origin}</small></span>
              {active === t.id ? (applying ? <span className="spinner sm" /> : <span className="chip accent">On</span>) : null}
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}
