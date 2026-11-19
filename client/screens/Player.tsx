import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRoute, readPlayParams, titleUrl, back, leaveTo } from '../lib/router';
import { isIOS, isTouch } from '../lib/player-caps';
import { preloadHls, type Attached } from '../lib/hls-attach';
import { useStore, setStore } from '../lib/store';
import { api } from '../lib/api';
import { Controls } from '../components/Controls';
import { Hud, ShortcutsSheet, useHud, useShortcutNudge } from '../components/Shortcuts';
import { SubtitleMenu } from '../components/SubtitleMenu';
import { IconCast } from '../components/Icons';
import { PlayOn } from '../components/PlayOn';
import { EpisodesShelf } from '../components/EpisodesShelf';
import { usePullDown } from '../components/usePullDown';
import { splitShowName } from '../components/home-data';
import { TvRemote } from './TvRemote';
import { TorrentStats } from '../components/TorrentStats';
import { Countdown } from '../components/Countdown';
import { CastPicker } from '../components/CastPicker';
import { StallSheet } from '../components/StallSheet';
import { SourcesSheet } from '../components/SourcesSheet';
import { anyPlayerSheet, type PlayerSheets } from '../lib/player-keys';
import { sleepBadge, sleepWords } from '../lib/sleep';
import { useIntro, useIntroLearner, SkipIntroButton, type IntroQuery } from '../components/SkipIntro';
import { inIntro } from '../lib/intro';
import { playHow, upNextMode, withMark, type Mark } from '../lib/playback';
import { useNotice, LoadingCenter, PlayerNotice, PlayerError, SleepSheet, AudioSheet } from './player/PlayerChrome';
import { useSession, useAudioSwitch } from './player/useSession';
import { useCueTrack, useCuePlacement, useSubtitles } from './player/useSubtitles';
import { useEpisodes } from './player/useEpisodes';
import { usePickLog, useProgress } from './player/useProgress';
import { useMediaEvents, useSeek, useStallWatch, useMediaSession } from './player/useMedia';
import { useVolume, usePlayerControls } from './player/useControls';
import { useSleep } from './player/useSleep';
import { useSendToTv } from './player/useSendToTv';
import { useSourceActions } from './player/useSourceActions';
import '../styles/player.css';
import '../styles/player-error.css';
import '../styles/subtitles.css';

/**
 * One player, two places it can play: this screen, or a TV with this screen as its remote (`tv` in the link). Moving
 * between them swaps the half that plays and keeps the route, so Back still leads where it did.
 */
export function Player() {
  const route = useRoute();
  const p = useMemo(() => readPlayParams(route.query), [route.query]);
  return p.tv ? <TvRemote p={p} /> : <LocalPlayer />;
}

/**
 * The film plays on this screen. Each hook in ./player does one job (the session, the video element, subtitles,
 * episodes, progress, the controls); this wires them together and lays out the screen.
 */
function LocalPlayer() {
  const route = useRoute();
  const p = useMemo(() => readPlayParams(route.query), [route.query]);
  // The refs every part of the play shares: made once here, handed down, never copied.
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Attached | null>(null);
  useEffect(preloadHls, []); // fetch hls.js alongside the play request, not after it
  const sessionRef = useRef<string | null>(null);
  const hlsOffsetRef = useRef(0); // HLS session start offset (s)
  const refs = { videoRef, hlsRef, sessionRef, hlsOffsetRef };
  const settings = useStore((s) => s.settings);
  const receivers = useStore((s) => s.receivers);
  const stats = useStore((s) => (s.stats && s.stats.infoHash === p.infoHash ? s.stats : null));

  const { notice, setNotice, showNotice } = useNotice();
  const [buffering, setBuffering] = useState(true);
  const [dur, setDur] = useState(0);
  // Places you were: the resume point and where a big jump back started. Shown as dots on the seek bar, tap to return.
  const [marks, setMarks] = useState<Mark[]>([]);
  const addMark = (m: Mark) => setMarks((ms) => withMark(ms, m));
  const { volume, muted, setVol, toggleMute } = useVolume();
  // ---- HUD + shortcuts: every action says what it did and which key does it ----
  const { hud, flash } = useHud();
  const showNudge = useShortcutNudge();
  const [keysOpen, setKeysOpen] = useState(false);
  const [subMenu, setSubMenu] = useState(false);
  const [srcOpen, setSrcOpen] = useState<false | { reason?: string }>(false);

  useEffect(() => { if (!settings) api.settings().then((s) => setStore({ settings: s })).catch(() => undefined); }, [settings]);

  const absTime = useCallback(() => (videoRef.current?.currentTime || 0) + hlsOffsetRef.current, []);
  const { watched, outcome, outcomeRef } = usePickLog(p, absTime);
  // The latest progress save (useProgress keeps it current), for whatever runs after the render that made it.
  const saveRef = useRef<(beacon?: boolean) => void>(() => undefined);
  const cue = useCueTrack(videoRef, hlsOffsetRef);
  const session = useSession({ p, ...refs, renderCues: cue.renderCues, offsetRef: cue.offsetRef, showNotice, setNotice, setBuffering, setDur, setMarks, outcomeRef, saveRef });
  const { play, setPlay, err, errInfo, phase, fail, retry, attach, startAt } = session;
  const totalDur = useCallback(() => play?.probe?.duration || videoRef.current?.duration || dur, [play, dur]);
  const { sleep, sleepMs, sleepOpen, setSleepOpen, pickSleep } = useSleep(p, videoRef, showNotice, setNotice);
  const sub = useSubtitles({ p, videoRef, cue, settings, play, absTime, flash, saveRef });
  const { subs, activeSub, subOffset, setSubOffset } = sub;
  const eps = useEpisodes({ p, attempt: session.attempt, play, totalDur, absTime, saveRef });
  const { meta, next, playNext, playEpisode } = eps;

  // ---- skip intro: a chapter, or where you skipped the titles in an earlier episode of this show ----
  const introQ = useMemo((): IntroQuery | null => (p.type === 'series' && !p.magnet && p.metaId && play ? { infoHash: p.infoHash, fileIdx: play.fileIdx, videoId: p.videoId, metaId: p.metaId } : null), [p.type, p.magnet, p.metaId, p.infoHash, p.videoId, play]);
  const intro = useIntro(introQ);
  const introLearn = useIntroLearner(introQ);

  useMediaSession({ p, videoRef, hlsOffsetRef, next, playNext });
  const { saveProgress, lastSave, lastPos } = useProgress({ p, videoRef, absTime, totalDur, movedOn: eps.movedOn, subRef: sub.subRef, subSettled: sub.subSettled, offsetRef: cue.offsetRef, saveRef });
  const media = useMediaEvents({
    videoRef, hlsOffsetRef, play, err, stats, volume, muted, fail, totalDur, saveProgress, lastSave, lastPos, setDur, setBuffering,
    autoRetries: session.autoRetries, watched, outcomeRef, next, nextShown: eps.nextShown, setShowNext: eps.setShowNext, setEnded: eps.setEnded, creditsRef: eps.creditsRef,
  });
  const { playing, cur, buffered } = media;
  const { seekTo, skip, togglePlay } = useSeek({ ...refs, play, attach, totalDur, absTime, lastSeekAt: media.lastSeekAt, setBuffering, setCur: media.setCur, addMark });
  const leave = () => { saveProgress(true); if (p.magnet) leaveTo('/magnet'); else if (p.metaId) leaveTo(titleUrl(p.type, p.metaId, p.type === 'series' ? p.videoId : undefined)); else back('/'); };

  const audio = useAudioSwitch({ p, play, setPlay, sessionRef, setBuffering, startAt, absTime, converted: session.converted, fileKey: session.fileKey });
  const tv = useSendToTv({ p, play, videoRef, phase, playing, err, receivers, absTime, activeSub, subOffset, saveProgress });
  const { stall, snoozeStall } = useStallWatch({ p, videoRef, phase, err, play, stats, buffering, playing, lastSeekAt: media.lastSeekAt, outcomeRef, srcOpen, setSrcOpen, showNotice, setNotice });
  const src = useSourceActions(p, absTime, outcome, leave);

  // Any open sheet owns the keyboard and keeps the controls up. The key listener reads the ref, so it never sees a stale set.
  const sheets: PlayerSheets = { keys: keysOpen, subs: subMenu, cast: tv.castOpen || tv.destOpen, sources: !!srcOpen, audio: audio.audioOpen, sleep: sleepOpen, stall: !!stall, episodes: eps.epsOpen };
  const sheetOpen = anyPlayerSheet(sheets);
  const sheetsRef = useRef(sheets); sheetsRef.current = sheets;
  const showIntro = phase === 'ready' && !err && inIntro(intro, cur);
  const canSources = !p.magnet && !!p.videoId;
  const ctl = usePlayerControls({
    videoRef, wrapRef, flash, showNotice, playing, togglePlay, skip, seekTo, absTime, totalDur, introLearn, intro, showIntro,
    volume, muted, setVol, toggleMute, subs, activeSub, toggleSubs: sub.toggleSubs, setSubOffset, next, playNext, sheetOpen, sheetsRef, setKeysOpen,
    openSubs: () => setSubMenu(true), openDest: () => tv.setDestOpen(true), openSources: canSources ? () => setSrcOpen({}) : undefined,
    openAudio: audio.audioTracks.length > 1 ? () => audio.setAudioOpen(true) : undefined, leave,
  });
  const { showCtl, poke } = ctl;

  // An episode reads as the TV app sets it: the show small over the episode's own title, then where it sits.
  const named = splitShowName(p.name);
  const epTitle = p.type === 'series' && p.season != null ? (meta?.videos?.find((v) => v.id === p.videoId)?.title || named.episode) : '';
  const kicker = epTitle ? meta?.name || named.show : undefined;
  const heading = epTitle || p.name;
  const where = p.type === 'series' && p.season != null ? `Season ${p.season}, Episode ${p.episode}` : '';
  const subtitleLine = [where, playHow(play)].filter(Boolean).join(' · ') || undefined;
  usePullDown(wrapRef, leave, isTouch && !err && !sheetOpen);
  useCuePlacement(videoRef, wrapRef, cue, showCtl);
  const dest = (
    <PlayOn open={tv.destOpen} onOpen={() => { tv.setDestOpen(true); tv.setCastPulse(null); }} onClose={() => tv.setDestOpen(false)} deviceId={null} busy={tv.sending} pulse={!!tv.castPulse}
      onTv={(d) => void tv.castTo(d)} onAirplay={ctl.airplay} />
  );
  const upNext = settings ? upNextMode({ ended: eps.ended, credits: eps.credits, autoNext: settings.autoNext, sleepEpisode: sleep === 'episode' }) : null;

  return (
    <div className={`player${showCtl ? '' : ' hide-cursor'}`} ref={wrapRef} onClick={ctl.onWrapClick} onDoubleClick={ctl.onWrapDbl} onPointerMove={() => poke()} onTouchStart={() => { /* handled in click */ }}>
      {/* 100% = what used to be 70% on desktop: big screens sit further away than the old scale assumed */}
      {/* The browser scales cues with the picture, so a phone held upright would get tiny ones: never under 13px. */}
      <style>{`.player video::cue{font-size:max(13px, ${sub.subSize / 100 * (isIOS ? 1.35 : 1.12)}em)}`}</style>
      <video ref={videoRef} playsInline crossOrigin="anonymous" preload="auto" poster={p.background || undefined} x-webkit-airplay="allow" />
      {(phase === 'loading' || buffering || !play) && !err ? <LoadingCenter loading={phase === 'loading'} play={play} stats={stats} name={p.name} background={p.background} onCancel={leave} /> : null}
      {stats && (showCtl || buffering) ? <TorrentStats s={stats} /> : null}
      {notice && !err ? <PlayerNotice notice={notice} onDismiss={() => setNotice(null)} /> : null}
      {err ? <PlayerError err={err} info={errInfo} canSwitch={canSources} onRetry={retry} onSwitch={() => setSrcOpen({ reason: err })} onLeave={leave} onTv={() => tv.setCastOpen(true)} /> : null}
      {phase === 'ready' && !err ? (
        <div className={`ctl-layer${showCtl || tv.destOpen ? '' : ' hidden'}`}>
          {tv.castPulse && !showCtl ? <button className="pc-circle cast-ghost cast-pulse" aria-label={`${tv.castPulse} is on. Play there`} title={`${tv.castPulse} is on`} onClick={() => { poke(); tv.setDestOpen(true); tv.setCastPulse(null); }}><IconCast /></button> : null}
          {showNudge ? <div className="key-nudge">Press <kbd className="keycap">?</kbd> for keyboard shortcuts</div> : null}
          <Controls title={heading} kicker={kicker} subtitle={subtitleLine} playing={playing} cur={cur} dur={totalDur()} buffered={buffered} marks={marks} volume={volume} muted={muted} subsOn={!!activeSub} dest={dest}
            onPlayPause={ctl.playPause} onSeek={ctl.userSeek} onSkip={(d) => ctl.skipH(d, d > 0 ? 'L' : 'J')} onVolume={setVol} onMute={ctl.muteH} onSubs={() => setSubMenu(true)} onFull={ctl.fullH} onPip={ctl.pipH} onKeys={() => setKeysOpen(true)}
            onBack={leave} onSources={canSources ? () => setSrcOpen({}) : undefined} onAudio={audio.audioTracks.length > 1 ? () => audio.setAudioOpen(true) : undefined} onSleep={() => setSleepOpen(true)} sleepLabel={sleepBadge(sleep, sleepMs)} sleepTitle={sleepWords(sleep, sleepMs)}
            onNext={next ? () => void playNext() : undefined} nextLabel={next ? `Next: S${next.season} E${next.episode}` : undefined} onEpisodes={meta?.videos?.length ? () => eps.setEpsOpen(true) : undefined} />
        </div>
      ) : null}
      {showIntro ? <SkipIntroButton onSkip={ctl.skipIntro} className={showCtl ? 'lifted' : ''} /> : null}
      {eps.showNext && next && settings && upNext ? <Countdown next={next} seconds={settings.autoNextDelaySec} credits={upNext.credits} auto={upNext.auto} onPlay={(manual) => void playNext(manual)} onCancel={() => eps.setShowNext(false)} /> : null}
      {meta ? <EpisodesShelf meta={meta} progress={eps.epProgress} current={p.videoId} open={eps.epsOpen} onPick={(e) => { if (e.id === p.videoId) eps.setEpsOpen(false); else void playEpisode(e); }} onClose={() => eps.setEpsOpen(false)} /> : null}
      <Hud hud={hud} />
      {keysOpen ? <ShortcutsSheet onClose={() => setKeysOpen(false)} /> : null}
      {subMenu ? <SubtitleMenu tracks={subs} active={activeSub?.id} offsetMs={subOffset} size={sub.subSize} loading={sub.subsLoading} applying={sub.subApplying} onPick={sub.pickSub} onOffset={setSubOffset} onAuto={p.magnet ? undefined : sub.autoSync} autoBusy={sub.syncBusy} onSize={sub.pickSize} onClose={() => setSubMenu(false)} /> : null}
      {tv.castOpen ? <CastPicker onPick={tv.castTo} busy={!!tv.sending} onClose={() => { tv.setCastOpen(false); tv.setCastSrc(null); }} /> : null}
      {sleepOpen ? <SleepSheet sleep={sleep} onPick={pickSleep} onClose={() => setSleepOpen(false)} /> : null}
      {audio.audioOpen ? <AudioSheet tracks={audio.audioTracks} current={play?.audioIndex} busy={audio.audioBusy} onPick={(i) => void audio.pickAudio(i)} onClose={() => audio.setAudioOpen(false)} /> : null}
      {srcOpen ? <SourcesSheet type={p.type} videoId={p.videoId} currentId={src.currentSourceId} reason={srcOpen.reason} onPick={src.switchTo} onCast={(s) => { setSrcOpen(false); tv.setCastSrc(s); tv.setCastOpen(true); }} onDownload={src.downloadSource} onClose={() => setSrcOpen(false)} /> : null}
      {stall ? <StallSheet reason={stall.reason} hint={stall.hint} canSwitch={canSources} canDownload busy={src.stallBusy}
        onSwitch={src.switchSource} onDownload={src.downloadLater} onPick={leave}
        onWait={snoozeStall} onClose={snoozeStall} /> : null}
    </div>
  );
}

