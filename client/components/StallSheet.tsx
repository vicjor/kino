import { Sheet } from './Sheet';
import { IconRefresh, IconDownload, IconWarn } from './Icons';

/**
 * Shown when playback has been stuck for a while. Says WHY (dead torrent, too
 * slow for the file size, transcoder behind) and offers the way out.
 */
export function StallSheet({ reason, hint, canSwitch, canDownload, busy, onSwitch, onDownload, onPick, onWait, onClose }: {
  reason: string; hint?: string; canSwitch: boolean; canDownload: boolean; busy?: boolean;
  onSwitch: () => void; onDownload: () => void; onPick: () => void; onWait: () => void; onClose: () => void;
}) {
  return (
    <Sheet title="Having trouble playing this" onClose={onClose}>
      <div className="stall">
        <div className="stall-reason"><span className="stall-ico"><IconWarn /></span><div><p>{reason}</p>{hint ? <p className="hint">{hint}</p> : null}</div></div>
        <div className="stall-actions">
          {canSwitch ? <button className="btn primary" disabled={busy} onClick={onSwitch}><IconRefresh /> Try the next best source</button> : null}
          {canDownload ? <button className="btn" disabled={busy} onClick={onDownload}><IconDownload /> Download and watch later</button> : null}
          {canSwitch ? <button className="btn ghost" disabled={busy} onClick={onPick}>Pick a source myself</button> : null}
          <button className="btn ghost" onClick={onWait}>Keep waiting</button>
        </div>
      </div>
    </Sheet>
  );
}
