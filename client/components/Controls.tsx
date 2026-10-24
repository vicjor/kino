import { useEffect, useState, useRef, type ReactNode } from 'react';
import { isIOS, isTouch } from '../lib/player-caps';
import { Scrubber, type Mark } from './Scrubber';
import { LevelSlider } from './LevelSlider';
import '../styles/rotate.css';
import { IconPlay, IconPause, IconBack10, IconFwd10, IconVol, IconMute, IconSubs, IconFull, IconPip, IconCast, IconDown, IconLayers, IconAudio, IconMoon, IconNext, IconGrid } from './Icons';

export interface ControlsProps {
  title: string; subtitle?: string;
  /** The show over an episode's own title, small and in capitals as the TV app sets it. */
  kicker?: string;
  playing: boolean; cur: number; dur: number; buffered: [number, number][]; marks?: Mark[];
  volume: number; muted: boolean; subsOn: boolean;
  /** Where it plays (PlayOn), in the top right corner. Without it, `onCast` gets a plain Cast button there. */
  dest?: ReactNode;
  onPlayPause: () => void; onSeek: (t: number) => void; onSkip: (d: number) => void;
  onVolume: (v: number) => void; onMute: () => void; onSubs?: () => void; onFull: () => void; onPip?: () => void; onCast?: () => void; onBack: () => void; onSources?: () => void; onAudio?: () => void; onSleep?: () => void; sleepLabel?: string; sleepTitle?: string; onNext?: () => void; nextLabel?: string; onKeys?: () => void; onEpisodes?: () => void;
}

/** Phone lying in portrait with rotation lock on: turn the whole player sideways ourselves. */
const IconLandscape = (props: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="8" width="18" height="12" rx="2.5" />
    <path d="M9 4.5 6.5 2 4 4.5M6.5 2v3.5" />
    <path d="M15 4.5 17.5 2 20 4.5M17.5 2v3.5" />
  </svg>
);

type FsDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const fsDoc = () => document as FsDoc;
const inFullscreen = () => !!(fsDoc().fullscreenElement || fsDoc().webkitFullscreenElement);
async function enterFullscreen(el: FsEl): Promise<void> {
  if (el.requestFullscreen) await el.requestFullscreen(); else el.webkitRequestFullscreen?.();
}
function exitFullscreen(): void {
  if (!inFullscreen()) return;
  if (document.exitFullscreen) document.exitFullscreen().catch(() => undefined); else fsDoc().webkitExitFullscreen?.();
}

/**
 * The Landscape button. The picture turns at once (a data attribute on the player root, so it survives the player's
 * own className updates); where the browser lets a page go fullscreen (Android, iPad) it also does, and where it may
 * turn the screen itself the screen turns and our turn steps aside. iPhone Safari allows neither to a page, so there
 * it is the turn alone, which fills the screen when Kino runs from the Home Screen.
 */
function useRotate(root: React.RefObject<HTMLDivElement | null>) {
  const [rotated, setRotated] = useState(false);
  const player = () => root.current?.closest<HTMLElement>('.player') ?? null;
  const set = (on: boolean) => { const el = player(); if (!el) return; el.toggleAttribute('data-rotated', on); setRotated(on); };
  // The moment the device really is landscape (lock off, phone turned), our fake rotation must go. Leaving the
  // fullscreen we entered (a swipe, the system's own button) leaves landscape too.
  useEffect(() => {
    const mq = matchMedia('(orientation: landscape)');
    const onChange = () => { if (mq.matches) set(false); };
    const onFs = () => { if (!inFullscreen()) set(false); };
    mq.addEventListener('change', onChange);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => { mq.removeEventListener('change', onChange); document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs); set(false); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => {
    const el = player(); if (!el) return;
    if (el.hasAttribute('data-rotated')) { set(false); exitFullscreen(); return; }
    set(true);
    if (!(document.fullscreenEnabled || fsDoc().webkitFullscreenEnabled) || inFullscreen()) return;
    enterFullscreen(el)
      .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
      .catch(() => undefined);
  };
  return { rotated, toggle };
}

// The overlay covers the whole player, so only its buttons and sliders count as hits; empty space
// behaves like the video (click to pause, double click for fullscreen, tap to hide the controls).
export const onPlayerChrome = (t: EventTarget, extra = '') => !!(t as HTMLElement).closest(`button, a, input, [role="slider"], .pc-vol, .playon-menu, .sheet-back${extra}`);

/** A glass capsule with an icon and, where there is room, its name. Lit white while the thing it toggles is on. */
function Pill({ icon, label, title, on, strong, k, onClick }: { icon: ReactNode; label: string; title?: string; on?: boolean; strong?: boolean; k?: string; onClick: () => void }) {
  return (
    <button className={`pc-pill${on ? ' on' : ''}${strong ? ' strong' : ''}`} aria-label={title || label} aria-pressed={on === undefined ? undefined : on} title={title} data-hint={title || label} data-key={k} onClick={onClick}>
      {icon}<span className="lbl">{label}</span>
    </button>
  );
}

/**
 * The player's chrome, laid out like the TV app: close and the window controls top left, where it plays and the
 * volume top right, the transport in the middle, and along the foot the title, the timeline and one row of pills for
 * everything else. All of it glass over the picture, fading as one when it steps aside.
 */
export function Controls(p: ControlsProps) {
  const root = useRef<HTMLDivElement>(null);
  const rot = useRotate(root);
  return (
    <div className="controls" ref={root}>
      <div className="pc-top">
        <div className="pc-group">
          <button className="pc-circle" aria-label="Close" data-hint="Close" data-key="Esc" onClick={p.onBack}><IconDown /></button>
          {p.onPip ? <button className="pc-circle" aria-label="Picture in picture" data-hint="Picture in picture" data-key="P" onClick={p.onPip}><IconPip /></button> : null}
          <button className="pc-circle" aria-label="Fullscreen" data-hint="Fullscreen" data-key="F" onClick={p.onFull}><IconFull /></button>
          {isTouch ? <button className={`pc-circle rotate-btn${rot.rotated ? ' on' : ''}`} aria-label={rot.rotated ? 'Back to portrait' : 'Landscape'} aria-pressed={rot.rotated} onClick={rot.toggle}><IconLandscape size={20} /></button> : null}
        </div>
        <div className="pc-group">
          {p.dest ?? (p.onCast ? <button className="pc-circle" aria-label="Cast" data-hint="Cast" data-key="T" onClick={p.onCast}><IconCast /></button> : null)}
          {!isIOS ? (
            <div className="pc-vol">
              <button className="pc-mute" aria-label={p.muted ? 'Unmute' : 'Mute'} data-hint={p.muted ? 'Unmute' : 'Mute'} data-key="M" onClick={p.onMute}>{p.muted || p.volume === 0 ? <IconMute /> : <IconVol />}</button>
              <LevelSlider value={p.muted ? 0 : p.volume} label="Volume" onChange={(v) => p.onVolume(Math.round(v * 100) / 100)} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="pc-mid">
        <button className="pc-skip" aria-label="Back 10 seconds" data-hint="Back 10 s" data-key="J" onClick={() => p.onSkip(-10)}><IconBack10 size={36} /></button>
        <button className="pc-play" aria-label={p.playing ? 'Pause' : 'Play'} data-hint={p.playing ? 'Pause' : 'Play'} data-key="K" onClick={p.onPlayPause}>
          <span className={`pc-glyph${p.playing ? '' : ' off'}`}><IconPause size={38} /></span>
          <span className={`pc-glyph play${p.playing ? ' off' : ''}`}><IconPlay size={38} /></span>
        </button>
        <button className="pc-skip" aria-label="Forward 10 seconds" data-hint="Forward 10 s" data-key="L" onClick={() => p.onSkip(10)}><IconFwd10 size={36} /></button>
      </div>
      <div className="pc-bottom">
        <div className="pc-info">
          {p.kicker ? <span className="pc-kicker">{p.kicker}</span> : null}
          <strong className="pc-title">{p.title}</strong>
          {p.subtitle ? <span className="pc-sub">{p.subtitle}</span> : null}
        </div>
        <Scrubber cur={p.cur} dur={p.dur} buffered={p.buffered} marks={p.marks} onSeek={p.onSeek} />
        <div className="pc-row">
          <div className="pc-pills">
            {p.onSubs ? <Pill icon={<IconSubs />} label="Subtitles" on={p.subsOn} k="C" onClick={p.onSubs} /> : null}
            {p.onAudio ? <Pill icon={<IconAudio />} label="Audio" k="A" onClick={p.onAudio} /> : null}
            {p.onSources ? <Pill icon={<IconLayers />} label="Source" title="Switch source" k="S" onClick={p.onSources} /> : null}
            {p.onSleep ? <Pill icon={<IconMoon />} label={p.sleepLabel ? `Sleep ${p.sleepLabel}` : 'Sleep'} title={p.sleepTitle || 'Sleep timer'} on={!!p.sleepLabel} onClick={p.onSleep} /> : null}
            {p.onKeys && !isTouch ? <button className="pc-pill keys-btn" aria-label="Keyboard shortcuts" data-hint="Shortcuts" data-key="?" onClick={p.onKeys}><span className="keys-glyph">?</span></button> : null}
          </div>
          <div className="pc-pills end">
            {p.onEpisodes ? <Pill icon={<IconGrid />} label="Episodes" onClick={p.onEpisodes} /> : null}
            {p.onNext ? <Pill icon={<IconNext />} label="Next episode" title={p.nextLabel || 'Next episode'} strong k="N" onClick={p.onNext} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
