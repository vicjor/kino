import { useCallback, useEffect, useRef, useState } from 'react';
import type { CastStatus, Episode, Meta, Progress, Source } from '../../server/types.js';
import { api } from '../lib/api';
import { useStore, setStore, getStore, toast } from '../lib/store';
import { navigate, back, playUrl, titleUrl, type PlayParams } from '../lib/router';
import { metaIdOf, isMagnetId, episodeOf, handoffPlayParams } from '../lib/handoff';
import { resumePoint } from '../lib/progress';
import { fmtTime, langName } from '../lib/format';
import { tvVolume, setTvVolume, stepVolume } from '../lib/cast-volume';
import { episodeSource } from '../lib/episodes';
import { sendToTv, type Tv } from '../lib/cast-actions';
import { isTouch } from '../lib/player-caps';
import { inIntro } from '../lib/intro';
import { splitShowName } from '../components/home-data';
import { Scrubber } from '../components/Scrubber';
import { LevelSlider } from '../components/LevelSlider';
import { PlayOn } from '../components/PlayOn';
import { EpisodesShelf } from '../components/EpisodesShelf';
import { SubtitleMenu } from '../components/SubtitleMenu';
import { SourcesSheet } from '../components/SourcesSheet';
import { CastUpNext } from '../components/CastUpNext';
import { Hud, ShortcutsSheet, CAST_SHORTCUTS, useHud } from '../components/Shortcuts';
import { useIntro, useIntroLearner, castIntroQuery, SkipIntroButton } from '../components/SkipIntro';
import { usePullDown } from '../components/usePullDown';
import { IconDown, IconPlay, IconPause, IconBack10, IconFwd10, IconVol, IconMute, IconSubs, IconLayers, IconGrid, IconNext, IconMoon, IconStop, IconTv, IconInfo } from '../components/Icons';
import '../styles/player.css';
import '../styles/tvremote.css';

type Sheet = null | 'subs' | 'sources' | 'episodes' | 'keys';

/**
 * Where the TV is now, ticking on between status pushes so the timeline moves smoothly instead of in steps. A seek
 * from here moves it at once (`jump`), before the TV confirms.
 */
function useCastClock(cast: CastStatus) {
  const base = useRef({ src: -1, state: '', t: 0, at: 0 });
  const b = base.current;
  if (cast.currentTime !== b.src || cast.state !== b.state) base.current = { src: cast.currentTime ?? 0, state: cast.state || '', t: cast.currentTime ?? 0, at: performance.now() };
  const playing = cast.active && cast.state === 'PLAYING';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const i = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(i);
  }, [playing]);
  const now = base.current;
  const t = playing ? now.t + (performance.now() - now.at) / 1000 : now.t;
  const jump = (to: number) => { base.current = { ...base.current, t: to, at: performance.now() }; tick((n) => n + 1); };
  return { pos: Math.max(0, Math.min(cast.duration || Infinity, t)), jump };
}

/**
 * The player as the TV's remote. It looks like the player because it is the player, only the picture is on the TV:
 * the artwork stands in for it (and settles back a little while paused), and the same timeline, transport, pills and
 * keys steer the TV. Where it plays is the same button too: this screen takes it back from where the TV is, another TV
 * takes it over. It follows the TV: when the next episode starts there, this shows it. When the TV stops, it says so
 * and offers to carry on here or there.
 */
export function TvRemote({ p }: { p: PlayParams }) {
  const cast = useStore((s) => s.cast);
  const receivers = useStore((s) => s.receivers);
  const on = cast.active;
  const videoId = on ? cast.videoId || '' : p.videoId;
  const type = on ? cast.type || p.type : p.type;
  const metaId = videoId ? metaIdOf(videoId) : p.metaId;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const last = useRef<{ id: string; name: string } | null>(null);
  if (on && cast.deviceId) last.current = { id: cast.deviceId, name: cast.deviceName || 'the TV' };

  useEffect(() => {
    if (!metaId || isMagnetId(videoId)) { setMeta(null); return; }
    let dead = false;
    api.meta(type, metaId).then((r) => { if (!dead) { setMeta(r.meta); setProgress(r.progress); } }).catch(() => undefined);
    return () => { dead = true; };
  }, [type, metaId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stopped: where you were, for "carry on here".
  useEffect(() => {
    if (on || !p.videoId) return;
    api.progress(p.videoId).then((pr) => setResumeAt(resumePoint(pr) ?? null)).catch(() => undefined);
  }, [on, p.videoId]);

  const { pos, jump } = useCastClock(cast);
  const dur = on ? cast.duration || 0 : 0;
  const playing = on && cast.state === 'PLAYING';
  const series = type === 'series' && !!videoId && !isMagnetId(videoId);
  const ep: Episode | undefined = meta?.videos?.find((v) => v.id === videoId);
  const code = episodeOf(videoId);
  const names = splitShowName((on ? cast.title : p.name) || p.name);
  const title = ep?.title || (series ? names.episode : names.show) || meta?.name || 'Kino';
  const kicker = series ? meta?.name || names.show : undefined;
  const line = series && code ? `Season ${code.season}, Episode ${code.episode}` : meta?.year ? String(meta.year) : undefined;
  const still = ep?.thumbnail || meta?.background || p.background || (on ? cast.poster : p.poster);
  const backdrop = meta?.background || still;
  const device = on && cast.deviceId ? (receivers || []).find((r) => r.id === cast.deviceId) : undefined;
  const tvName = (on ? cast.deviceName || device?.name : last.current?.name) || 'the TV';
  const status = !on ? (last.current ? `Stopped on ${tvName}` : 'Not playing on a TV') : cast.state === 'BUFFERING' || cast.state === 'IDLE' ? `Starting on ${tvName}…` : cast.state === 'PAUSED' ? `Paused on ${tvName}` : `Playing on ${tvName}`;
  const canSwitch = on && !!cast.videoId && !isMagnetId(cast.videoId);

  const close = useCallback(() => back(metaId && !isMagnetId(videoId) ? titleUrl(type, metaId, series ? videoId : undefined) : '/'), [metaId, videoId, type, series]);
  usePullDown(root, close, isTouch);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try { const r = await f(); if (r && typeof r === 'object' && 'active' in r) setStore({ cast: r as CastStatus }); }
    catch (e) { toast((e as Error).message, 'error', 5000); }
    finally { setBusy(false); }
  };
  const seek = (t: number) => { const x = Math.max(0, Math.min(dur ? dur - 1 : t, t)); jump(x); void run(() => api.castSeek(x)); };
  // Skipping the titles by hand here teaches Kino, same as in the player.
  const introQ = on ? castIntroQuery(cast) : null;
  const intro = useIntro(introQ);
  const introLearn = useIntroLearner(introQ);
  const skip = (d: number) => { if (!on || !dur) return; introLearn.onJump(pos, pos + d); seek(pos + d); };
  const showIntro = on && !cast.upNext && !!intro?.end && inIntro(intro, pos);
  const playPause = () => run(() => (playing ? api.castPause() : api.castResume()));

  // TV volume: the bar moves under the finger at once, the TV hears about it a few times a second and on release.
  const tv = tvVolume(cast, receivers);
  const [vol, setVol] = useState<number | null>(null);
  const sentAt = useRef(0);
  const onVol = (v: number, final: boolean) => {
    setVol(final ? null : v);
    if (!final && Date.now() - sentAt.current < 150) return;
    sentAt.current = Date.now();
    setTvVolume(tv, { level: Math.round(v * 100) / 100, muted: false }).catch((e) => toast((e as Error).message, 'error'));
  };

  // ---- where it plays ----
  const here = async () => {
    setMoving('here');
    try {
      const h = await api.castHandoff();
      if (!h) { toast('Nothing to pick up: the TV already stopped'); return; }
      const ep2 = episodeOf(h.videoId);
      navigate(playUrl({ ...handoffPlayParams(cast.type, h), background: meta?.background || p.background, season: ep2?.season, episode: ep2?.episode }), true);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setMoving(null); setMenu(false); }
  };
  // Another TV takes over from where this one is, same subtitles. Stopped: the TV picks up from where you left off.
  const sendTo = async (d: Tv) => {
    setMoving(d.id);
    const from = on ? { infoHash: cast.infoHash!, fileIdx: cast.fileIdx ?? -1, videoId: cast.videoId, title: cast.title || p.name, poster: cast.poster, startTime: pos, subId: cast.activeSubId ?? null, subOffsetMs: cast.subOffsetMs }
      : { infoHash: p.infoHash, fileIdx: p.fileIdx ?? -1, videoId: p.videoId, title: p.name, poster: p.poster, startTime: resumeAt ?? 0 };
    await sendToTv(d, async (deviceId) => setStore({ cast: await api.castPlay({ deviceId, ...from }) }), on ? `Moved to ${d.name}` : `Playing on ${d.name}`);
    setMoving(null); setMenu(false);
  };
  const playHereFromStop = () => navigate(playUrl({ ...p, tv: undefined, t: undefined }), true);

  // ---- episodes, sources, subtitles ----
  const castEpisode = async (e: Episode) => {
    if (!cast.deviceId || !meta) return;
    setSheet(null);
    await run(async () => {
      const tgt = device?.kind === 'dlna' ? 'browser' : 'chromecast';
      const r = await api.streams('series', e.id, tgt);
      const src = episodeSource(r.sources, r.auto, sessionStorage.getItem('kino.binge'));
      if (!src) throw new Error('No sources for that episode');
      const prog = await api.progress(e.id).catch(() => null);
      toast(`S${e.season} E${e.episode} on its way to ${tvName}`);
      return api.castPlay({ deviceId: cast.deviceId!, infoHash: src.infoHash, fileIdx: src.fileIdx ?? -1, videoId: e.id, title: `${meta.name} S${e.season} E${e.episode} ${e.title || ''}`.trim(), poster: meta.poster, startTime: resumePoint(prog) ?? 0 });
    });
  };
  const pickEpisode = (e: Episode) => {
    if (e.id === videoId) { setSheet(null); return; }
    if (on) void castEpisode(e);
    else navigate(titleUrl('series', metaId, e.id));
  };
  const switchTo = (s: Source) => {
    setSheet(null);
    toast(`Switching to ${s.provider || s.addon}${s.resolution && s.resolution !== 'other' ? ` ${s.resolution}` : ''} on ${tvName}`);
    void run(() => api.castSource(s.infoHash, s.fileIdx));
  };
  const sub = (id: string | null, ms?: number) => run(() => api.castSubtitle(id, ms));
  const next = () => run(async () => { const c = await api.castNext(); toast('Next episode on its way'); return c; });
  const stopAfter = () => run(() => api.castUpNext(!cast.stopAfter));
  const stop = async () => { await run(() => api.castStop()); close(); };

  // ---- keys: the player's, aimed at the TV ----
  const { hud, flash } = useHud();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || menu || e.defaultPrevented || (e.target as HTMLElement).tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const app = getStore(); if (app.ccOpen || app.palOpen) return;   // the Cast Center or the palette over the remote owns the keys
      const k = e.key; const stopKey = () => e.preventDefault();
      if (k === 'Escape') { stopKey(); close(); return; }
      if (k === '?') { setSheet('keys'); stopKey(); return; }
      if (!on) return;
      if (k === ' ' || k === 'k' || k === 'K') { flash(playing ? 'Pause' : 'Play', 'K'); void playPause(); stopKey(); }
      else if (k === 'ArrowLeft' || k === 'j' || k === 'J') { const d = e.shiftKey ? -60 : -10; flash(d === -60 ? '−1 min' : '−10 s', k === 'ArrowLeft' ? (e.shiftKey ? '⇧ ←' : '←') : 'J'); skip(d); stopKey(); }
      else if (k === 'ArrowRight' || k === 'l' || k === 'L') { const d = e.shiftKey ? 60 : 10; flash(d === 60 ? '+1 min' : '+10 s', k === 'ArrowRight' ? (e.shiftKey ? '⇧ →' : '→') : 'L'); skip(d); stopKey(); }
      else if (/^[0-9]$/.test(k) && dur) { const n = Number(k); flash(n ? `${n * 10}%` : 'Start', k); seek(dur * n / 10); stopKey(); }
      else if ((k === 'ArrowUp' || k === 'ArrowDown') && !tv.unknown) { const v = stepVolume(tv.level, k === 'ArrowUp' ? 0.05 : -0.05); flash(`Volume ${Math.round(v * 100)}%`, k === 'ArrowUp' ? '↑' : '↓'); void setTvVolume(tv, { level: v, muted: false }).catch(() => undefined); stopKey(); }
      else if ((k === 'm' || k === 'M') && !tv.unknown) { flash(tv.muted ? 'Sound on' : 'Muted', 'M'); void setTvVolume(tv, { muted: !tv.muted }).catch(() => undefined); stopKey(); }
      else if ((k === 'n' || k === 'N') && series) { flash('Next episode', 'N'); void next(); stopKey(); }
      else if (k === 'v' || k === 'V') {
        const avail = (cast.subs || []).filter((t) => t.available);
        if (cast.activeSubId) { flash('Subtitles off', 'V'); void sub(null); }
        else { const t = avail.find((x) => x.recommended) || avail[0]; if (t) { flash(`Subtitles: ${langName(t.lang)}`, 'V'); void sub(t.id); } else flash('No subtitles', 'V'); }
        stopKey();
      }
      else if (k === 'c' || k === 'C') { setSheet('subs'); stopKey(); }
      else if ((k === 'e' || k === 'E') && series) { flash(cast.stopAfter ? 'Auto-next on' : 'Stopping after this episode', 'E'); void stopAfter(); stopKey(); }
      else if ((k === 'i' || k === 'I') && showIntro && intro?.end != null) { flash('Skipped the intro', 'I'); introLearn.reset(); seek(intro.end); stopKey(); }
      else if ((k === 's' || k === 'S') && canSwitch) { setSheet('sources'); stopKey(); }
      else if (k === 'h' || k === 'H') { flash('Playing here', 'H'); void here(); stopKey(); }
      else if (k === 't' || k === 'T') { setMenu(true); stopKey(); }
      else if (k === 'x' || k === 'X') { flash('Stopped', 'X'); void stop(); stopKey(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });   // every render: the handlers close over live state and are cheap to rebind

  const level = vol ?? (tv.muted ? 0 : tv.level);
  return (
    <div className={`tvr${on && !playing ? ' paused' : ''}${on ? '' : ' ended'}`} ref={root} style={backdrop ? { ['--art' as string]: `url("${backdrop}")` } : undefined}>
      <div className="tvr-bg" aria-hidden="true" />
      <div className="tvr-col">
        <div className="tvr-head">
          <button className="pc-circle" aria-label="Close" data-hint="Close" data-key="Esc" onClick={close}><IconDown /></button>
          <span className="tvr-grab" aria-hidden="true" />
          <PlayOn open={menu} onOpen={() => setMenu(true)} onClose={() => setMenu(false)} deviceId={on ? cast.deviceId || null : null} busy={moving}
            onTv={(d) => void sendTo(d)} onHere={on ? () => void here() : playHereFromStop} />
        </div>
        <div className="tvr-art">
          {still ? <img src={still} alt="" /> : <span className="tvr-art-glyph"><IconTv /></span>}
          <span className="tvr-badge"><IconTv />{status}</span>
          {showIntro ? <SkipIntroButton onSkip={() => { introLearn.reset(); flash('Skipped the intro', 'I'); seek(intro!.end!); }} /> : null}
        </div>
        <div className="tvr-panel">
          <div className="tvr-titles">
            {kicker ? <span className="pc-kicker">{kicker}</span> : null}
            <h1 className="tvr-title">{title}</h1>
            {line ? <span className="pc-sub">{line}</span> : null}
          </div>
          {on ? (
            <>
              <Scrubber cur={pos} dur={dur} onSeek={(t) => { introLearn.onJump(pos, t); seek(t); }} disabled={!dur} />
              <div className="tvr-transport">
                <button className="tvr-skip" disabled={!dur} aria-label="Back 10 seconds" data-hint="Back 10 s" data-key="J" onClick={() => skip(-10)}><IconBack10 size={40} /></button>
                <button className="tvr-play" disabled={busy && cast.state === 'IDLE'} aria-label={playing ? 'Pause' : 'Play'} data-hint={playing ? 'Pause' : 'Play'} data-key="K" onClick={() => void playPause()}>
                  <span className={`pc-glyph${playing ? '' : ' off'}`}><IconPause size={44} /></span>
                  <span className={`pc-glyph play${playing ? ' off' : ''}`}><IconPlay size={44} /></span>
                </button>
                <button className="tvr-skip" disabled={!dur} aria-label="Forward 10 seconds" data-hint="Forward 10 s" data-key="L" onClick={() => skip(10)}><IconFwd10 size={40} /></button>
              </div>
              {tv.unknown ? null : <LevelSlider className="tvr-vol" value={level} label={`${tvName} volume`} onChange={onVol}
                before={<button className="tvr-vol-ico" aria-label={tv.muted ? 'Unmute' : 'Mute'} onClick={() => void setTvVolume(tv, { muted: !tv.muted }).catch(() => undefined)}>{tv.muted || level === 0 ? <IconMute /> : <IconVol />}</button>}
                after={<span className="tvr-vol-pct" aria-hidden="true">{Math.round(level * 100)}</span>} />}
              <div className="tvr-actions">
                <button className={`pc-pill${cast.activeSubId ? ' on' : ''}`} aria-pressed={!!cast.activeSubId} data-hint="Subtitles" data-key="C" onClick={() => setSheet('subs')}><IconSubs /><span className="lbl">Subtitles</span></button>
                {canSwitch ? <button className="pc-pill" data-hint="Switch source" data-key="S" onClick={() => setSheet('sources')}><IconLayers /><span className="lbl">Source</span></button> : null}
                {series && meta?.videos?.length ? <button className="pc-pill" onClick={() => setSheet('episodes')}><IconGrid /><span className="lbl">Episodes</span></button> : null}
                {series ? <button className={`pc-pill${cast.stopAfter ? ' on' : ''}`} aria-pressed={!!cast.stopAfter} title={cast.stopAfter ? 'Stopping after this episode. Tap to keep going' : 'Stop after this episode'} data-hint="Stop after this episode" data-key="E" disabled={busy} onClick={() => void stopAfter()}><IconMoon /><span className="lbl">{cast.stopAfter ? 'Sleep after this one' : 'Sleep'}</span></button> : null}
                {series ? <button className="pc-pill strong" data-hint="Next episode" data-key="N" disabled={busy} onClick={() => void next()}><IconNext /><span className="lbl">Next episode</span></button> : null}
                <button className="pc-pill danger" data-hint="Stop casting" data-key="X" disabled={busy} onClick={() => void stop()}><IconStop /><span className="lbl">Stop</span></button>
              </div>
              {cast.error ? <p className="tvr-error">{cast.error}</p> : null}
            </>
          ) : (
            <div className="tvr-ended">
              <p>{last.current ? `${tvName} stopped${resumeAt ? ` at ${fmtTime(resumeAt)}` : ''}.` : 'Nothing from Kino is on a TV right now.'} Carry on here, or put it back on.</p>
              <div className="tvr-ended-actions">
                <button className="btn primary big" onClick={playHereFromStop}><IconPlay />{resumeAt ? `Play here from ${fmtTime(resumeAt)}` : 'Play here'}</button>
                {last.current ? <button className="btn glass" disabled={!!moving} onClick={() => void sendTo(last.current!)}><IconTv />Back on {last.current.name}</button> : <button className="btn glass" onClick={() => setMenu(true)}><IconTv />Choose a TV</button>}
                {metaId && !isMagnetId(p.videoId) ? <button className="btn glass" onClick={() => navigate(titleUrl(p.type, metaId, series ? p.videoId : undefined), true)}><IconInfo />Details</button> : null}
              </div>
            </div>
          )}
        </div>
      </div>
      {on ? <CastUpNext /> : null}
      {meta ? <EpisodesShelf meta={meta} progress={progress} current={videoId} open={sheet === 'episodes'} onPick={pickEpisode} onClose={() => setSheet(null)} /> : null}
      {sheet === 'subs' ? (
        <SubtitleMenu title={`Subtitles on ${tvName}`} tracks={cast.subs || []} active={cast.activeSubId} offsetMs={cast.subOffsetMs || 0} loading={false} applying={busy}
          onPick={(t) => void sub(t ? t.id : null)} onOffset={(ms) => void sub(cast.activeSubId || null, ms)} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'sources' && canSwitch ? (
        <SourcesSheet type={cast.type || 'movie'} videoId={cast.videoId!} currentId={`${cast.infoHash}:${cast.fileIdx ?? -1}`} target={device?.kind === 'dlna' ? 'browser' : 'chromecast'}
          title={`Source on ${tvName}`} hint="Pick another release and the TV carries on from where it is, same subtitles." onPick={switchTo} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'keys' ? <ShortcutsSheet title="Remote shortcuts" groups={CAST_SHORTCUTS} onClose={() => setSheet(null)} /> : null}
      <Hud hud={hud} />
    </div>
  );
}
