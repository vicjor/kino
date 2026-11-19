import { useCallback, useRef, useState } from 'react';
import type { PlayResponse, TorrentStats as Stats } from '../../../server/types.js';
import { IconX } from '../../components/Icons';
import { Sheet } from '../../components/Sheet';
import { waitWords } from '../../lib/play-errors';
import { langName, audioDetail } from '../../lib/format';
import { SLEEP_CHOICES, sleepPicked, type Sleep, type SleepChoice } from '../../lib/sleep';

/** Transient chip with one action: "Resumed at 12:34 · Start over", "Back to 43:10". */
export interface Notice { text: string; action?: { label: string; run: () => void } }
export type ShowNotice = (n: Notice, ms?: number) => void;

/** The notice chip's state: `showNotice` puts one up for `ms` (9 s by default), `setNotice(null)` takes it down. */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback<ShowNotice>((n, ms = 9000) => {
    setNotice(n);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
  }, []);
  return { notice, setNotice, showNotice };
}

/** While the play request runs (artwork behind, a way out) and whenever the video waits for data. */
export function LoadingCenter({ loading, play, stats, name, background, onCancel }: { loading: boolean; play: PlayResponse | null; stats: Stats | null; name?: string; background?: string; onCancel: () => void }) {
  return (
    <div className={`pcenter${loading ? ' loading' : ''}`} style={loading && background ? { ['--art' as string]: `url("${background}")` } : undefined}>
      <div className="spinner" />
      <div className="msg">{waitWords(loading, play, stats)}</div>
      {loading ? <div className="msg dim">{name}</div> : null}
      {loading ? <button className="btn glass pcenter-cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}>Cancel</button> : null}
    </div>
  );
}

export function PlayerNotice({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div className="pnotice" onClick={(e) => e.stopPropagation()}>
      <span>{notice.text}</span>
      {notice.action ? <button className="btn small primary" onClick={notice.action.run}>{notice.action.label}</button> : null}
      <button className="pnotice-x" aria-label="Dismiss" onClick={onDismiss}><IconX /></button>
    </div>
  );
}

/** Why playback failed, in plain words with a hint and the raw detail. `lost`: Kino itself does not answer. */
export interface ErrInfo { hint?: string; detail?: string; retry?: boolean; lost?: boolean }

/** One place for a failure, and a way back: try again, another source, or a TV. */
export function PlayerError({ err, info, canSwitch, onRetry, onSwitch, onLeave, onTv }: { err: string; info: ErrInfo | null; canSwitch: boolean; onRetry: () => void; onSwitch: () => void; onLeave: () => void; onTv: () => void }) {
  return (
    <div className="perror" onClick={(e) => e.stopPropagation()}>
      <strong>Playback stopped</strong>
      <p>{err}</p>
      {info?.hint ? <p className="perror-hint">{info.hint}</p> : null}
      {info?.detail ? <code className="perror-detail">{info.detail}</code> : null}
      <div className="perror-actions">
        {info?.retry ? <button className="btn primary" onClick={onRetry}>Try again</button> : null}
        {info?.lost ? null : canSwitch ? <button className={`btn${info?.retry ? '' : ' primary'}`} onClick={onSwitch}>Switch source</button> : <button className={`btn${info?.retry ? '' : ' primary'}`} onClick={onLeave}>Choose another source</button>}
        {info?.lost ? null : <button className="btn" onClick={onTv}>Play on a TV</button>}
      </div>
    </div>
  );
}

export function SleepSheet({ sleep, onPick, onClose }: { sleep: Sleep; onPick: (c: SleepChoice) => void; onClose: () => void }) {
  return (
    <Sheet title="Sleep timer" onClose={onClose} side>
      <p className="hint">Pause playback later, so falling asleep does not cost you three episodes.</p>
      {SLEEP_CHOICES.map(({ label, choice }) => (
        <button key={label} className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => onPick(choice)}><span className="grow">{label}</span>{sleepPicked(sleep, choice) ? <span className="chip accent">On</span> : null}</button>
      ))}
    </Sheet>
  );
}

type AudioTrack = NonNullable<PlayResponse['probe']>['audio'][number];

export function AudioSheet({ tracks, current, busy, onPick, onClose }: { tracks: AudioTrack[]; current?: number; busy: boolean; onPick: (index: number) => void; onClose: () => void }) {
  return (
    <Sheet title="Audio track" onClose={onClose} side>
      <p className="hint">This file has {tracks.length} audio tracks. Playback continues from where you are.</p>
      {tracks.map((a) => (
        <button key={a.index} className="row" style={{ width: '100%', textAlign: 'left' }} disabled={busy} onClick={() => onPick(a.index)}>
          <span className="grow">{langName(a.lang || 'und')}{a.title ? ` · ${a.title}` : ''}{audioDetail(a.codec, a.channels) ? <small>{audioDetail(a.codec, a.channels)}</small> : null}</span>
          {current === a.index ? (busy ? <span className="spinner sm" /> : <span className="chip accent">On</span>) : null}
        </button>
      ))}
    </Sheet>
  );
}
