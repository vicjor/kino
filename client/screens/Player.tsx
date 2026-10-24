import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import type { PlayResponse, SubtitleTrack, Episode, Meta, Source, PickOutcome, Progress } from '../../server/types.js';
import { api, errorCode } from '../lib/api';
import { resumePoint } from '../lib/progress';
import { useRoute, navigate, readPlayParams, playUrl, titleUrl, back, leaveTo } from '../lib/router';
import { target, caps, isIOS, isTouch } from '../lib/player-caps';
import { attachMedia, preloadHls, type Attached } from '../lib/hls-attach';
import { useStore, setStore, getStore, toast } from '../lib/store';
import { Controls, onPlayerChrome } from '../components/Controls';
import { Hud, ShortcutsSheet, useHud, useShortcutNudge } from '../components/Shortcuts';
import { SubtitleMenu } from '../components/SubtitleMenu';
import { IconX, IconCast } from '../components/Icons';
import { PlayOn } from '../components/PlayOn';
import { EpisodesShelf } from '../components/EpisodesShelf';
import { usePullDown } from '../components/usePullDown';
import { splitShowName } from '../components/home-data';
import { episodeSource } from '../lib/episodes';
import { TvRemote } from './TvRemote';
import { TorrentStats } from '../components/TorrentStats';
import { Countdown } from '../components/Countdown';
import { CastPicker } from '../components/CastPicker';
import { StallSheet } from '../components/StallSheet';
import { sendToTv, type Tv } from '../lib/cast-actions';
import { onSse } from '../lib/sse';
import { startWords, stoppedWords, toastWords, endedEarlyWords, endedEarlyDetail, waitWords, stallWords, slowWords, stutterWords, autoRetry, MEDIA } from '../lib/play-errors';
import { SourcesSheet } from '../components/SourcesSheet';
import { sortedEpisodes } from '../components/EpisodePicker';
import { fmtTime, langName, audioDetail } from '../lib/format';
import { playerKeyRoute, anyPlayerSheet, type PlayerSheets } from '../lib/player-keys';
import { SLEEP_CHOICES, startSleep, sleepLeft, sleepPicked, sleepBadge, sleepWords, keepSleep, keptSleep, type Sleep, type SleepChoice } from '../lib/sleep';
import { Sheet } from '../components/Sheet';
import { useIntro, useIntroLearner, SkipIntroButton, type IntroQuery } from '../components/SkipIntro';
import { inIntro } from '../lib/intro';
import { parseVtt, cueLineFor, type Cue } from '../lib/vtt';
import '../styles/player.css';
import '../styles/player-error.css';
import '../styles/subtitles.css';

const LS_LANG = 'kino.subLang';
const LS_VOL = 'kino.volume';

/**
 * One player, two places it can play: this screen, or a TV with this screen as its remote (`tv` in the link). Moving
 * between them swaps the half that plays and keeps the route, so Back still leads where it did.
 */
export function Player() {
  const route = useRoute();
  const p = useMemo(() => readPlayParams(route.query), [route.query]);
  return p.tv ? <TvRemote p={p} /> : <LocalPlayer />;
}

function LocalPlayer() {
  const route = useRoute();
  const p = useMemo(() => readPlayParams(route.query), [route.query]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Attached | null>(null);
  useEffect(preloadHls, []); // fetch hls.js alongside the play request, not after it
  const sessionRef = useRef<string | null>(null);
  const offsetRef = useRef(0);   // subtitle time offset (ms)
  const hlsOffsetRef = useRef(0); // HLS session start offset (s)
  const subTrackRef = useRef<TextTrack | null>(null);
  const subCuesRef = useRef<Cue[]>([]);
  const subReqRef = useRef(0);
  const hideTimer = useRef<number | null>(null);
  const lastSave = useRef(0);
  const nextShown = useRef(false);
  const settings = useStore((s) => s.settings);
  const receivers = useStore((s) => s.receivers);
  const stats = useStore((s) => (s.stats && s.stats.infoHash === p.infoHash ? s.stats : null));

  const [play, setPlay] = useState<PlayResponse | null>(null);
  const [err, setErr] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  // Transient chip with one action: "Resumed at 12:34 · Start over", "Back to 43:10".
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback((n: { text: string; action?: { label: string; run: () => void } }, ms = 9000) => {
    setNotice(n);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
  }, []);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(LS_VOL) ?? 1));
  const [muted, setMuted] = useState(false);
  const [showCtl, setShowCtl] = useState(true);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subApplying, setSubApplying] = useState(false);
  const [activeSub, setActiveSub] = useState<SubtitleTrack | null>(null);
  // The subtitle in use rides along with every progress save, once the list has loaded and a choice (or "off") is settled.
  const subRef = useRef<SubtitleTrack | null>(null); subRef.current = activeSub;
  const subSettled = useRef(false);
  const subManual = useRef(false);   // picked in the menu this play
  const [subOffset, setSubOffset] = useState(0);
  const [subSize, setSubSize] = useState(100);
  const [subMenu, setSubMenu] = useState(false);
  const [castOpen, setCastOpen] = useState(false);
  const [destOpen, setDestOpen] = useState(false);   // the Play on list in the corner
  const [sending, setSending] = useState<string | null>(null);
  const [epsOpen, setEpsOpen] = useState(false);
  const [epProgress, setEpProgress] = useState<Record<string, Progress>>({});
  const [castPulse, setCastPulse] = useState<string | null>(null);   // name of the TV that is on
  const [stall, setStall] = useState<{ reason: string; hint?: string } | null>(null);
  const [srcOpen, setSrcOpen] = useState<false | { reason?: string }>(false);
  const [castSrc, setCastSrc] = useState<Source | null>(null);
  const [audioOpen, setAudioOpen] = useState(false);
  // Sleep timer: pause at a wall-clock time or at the end of this episode (no auto-next). Each episode or source is
  // a new player: it starts with the timer the last one left, if that still applies here (keptSleep).
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleep, setSleep] = useState<Sleep>(() => keptSleep(p));
  useEffect(() => { keepSleep(sleep, p); }, [sleep, p]);
  const [sleepMs, setSleepMs] = useState(0);   // left on a timed sleep, ticks once a second
  const lastTap = useRef<{ t: number; x: number }>({ t: 0, x: 0 });
  const [audioBusy, setAudioBusy] = useState(false);   // cast a different release than the one playing
  const rebuffers = useRef<number[]>([]);       // timestamps of stalls while playing
  const lastSeekAt = useRef(0);                  // a seek buffers too: that is not the stream stuttering
  const weakNudged = useRef(0);
  const [stallBusy, setStallBusy] = useState(false);
  const stallSnooze = useRef(0);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [next, setNext] = useState<Episode | null>(null);
  const [showNext, setShowNext] = useState(false);
  // Where the credits start, estimated server-side; the popup fires there instead of a flat 30 s before the end.
  const [credits, setCredits] = useState<{ at?: number; source: string; confidence: string } | null>(null);
  const creditsRef = useRef<{ at?: number; confidence: string } | null>(null);
  useEffect(() => { creditsRef.current = credits; }, [credits]);
  const [ended, setEnded] = useState(false);

  useEffect(() => { if (settings) setSubSize(settings.subFontSize); }, [settings]);
  useEffect(() => { if (!settings) api.settings().then((s) => setStore({ settings: s })).catch(() => undefined); }, [settings]);

  const absTime = useCallback(() => (videoRef.current?.currentTime || 0) + hlsOffsetRef.current, []);
  const totalDur = useCallback(() => play?.probe?.duration || videoRef.current?.duration || dur, [play, dur]);

  // ---- the pick log learns what became of a release picked from a source list (server/picks.ts) ----
  // The server ties it to the pick and keeps one line per kind; a release no list pick names logs nothing.
  const watched = useRef({ sec: 0, last: -1 });   // seconds of video played here, seeks and reloads left out
  const outcome = useCallback((kind: PickOutcome) => {
    if (!p.videoId || p.magnet) return;
    void api.logOutcome({ videoId: p.videoId, chosen: `${p.infoHash}:${p.fileIdx ?? -1}`, outcome: kind, pos: Math.round(absTime()), watchedSec: Math.round(watched.current.sec) });
  }, [p, absTime]);
  const outcomeRef = useRef(outcome); outcomeRef.current = outcome;

  // ---- failure: one place, plain words, a hint, the raw detail, and a way back ----
  const [errInfo, setErrInfo] = useState<{ hint?: string; detail?: string; retry?: boolean } | null>(null);
  const retryFrom = useRef<number | null>(null);
  // Places you were: the resume point and where a big jump back started. Shown as dots on the seek bar, tap to return.
  const [marks, setMarks] = useState<{ t: number; label: string }[]>([]);
  const addMark = (m: { t: number; label: string }) => setMarks((ms) => [...ms.filter((x) => Math.abs(x.t - m.t) > 30), m].slice(-3));
  const [attempt, setAttempt] = useState(0);
  const statsRef = useRef(stats); statsRef.current = stats;
  // A server restart (deploy, crash, sleep) kills the stream. Before showing an error,
  // wait for /health to answer again and pick up where we were, silently, twice.
  const autoRetries = useRef(0);
  const retryRef = useRef<() => void>(() => undefined);
  // `code` is the server's (ErrorCode): a full disk or a broken program is shown at once, no quiet retries.
  const fail = useCallback((msg: string, info: { hint?: string; detail?: string; retry?: boolean; code?: string } = {}) => {
    if (info.code === 'no-peers' || info.code === 'unreadable') outcomeRef.current(info.code);
    if (info.retry && autoRetry(info.code) && autoRetries.current < 2) {
      autoRetries.current++;
      setBuffering(true);
      showNotice({ text: 'Reconnecting…' }, 25_000);
      const until = Date.now() + 25_000;
      const probe = () => api.health().then(() => { setNotice(null); retryRef.current(); }).catch(() => { if (Date.now() < until) setTimeout(probe, 1500); else { setNotice(null); setErr(msg); setErrInfo(info); setBuffering(false); } });
      setTimeout(probe, 1200);
      return;
    }
    setErr((cur) => cur || msg);
    setErrInfo((cur) => cur || info);
    setBuffering(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const retry = () => { retryFrom.current = (videoRef.current?.currentTime || 0) + hlsOffsetRef.current; setErr(''); setErrInfo(null); setAttempt((a) => a + 1); };
  retryRef.current = retry;

  // Render subtitles from JS-managed cues instead of a <track> element: the video
  // never reloads, hls.js never fights a native track, and the fetch happens in
  // the background while playback continues. Cue times are absolute (file time);
  // an HLS session's timeline starts at hlsOffset, so shift them back by it.
  const cueLine = useRef(-6);   // a few lines up while the controls show, nearer the edge when they go (below)
  const renderCues = useCallback((ms: number) => {
    const v = videoRef.current; if (!v) return;
    let tt = subTrackRef.current;
    if (tt && !Array.from(v.textTracks).includes(tt)) tt = null; // lost on a media reload
    if (!tt) { if (!subCuesRef.current.length) return; tt = v.addTextTrack('subtitles', 'Kino', 'und'); subTrackRef.current = tt; }
    if (tt.cues) for (const c of Array.from(tt.cues)) tt.removeCue(c);
    const off = ms / 1000 - hlsOffsetRef.current;
    for (const c of subCuesRef.current) {
      const start = c.start + off;
      const end = c.end + off;
      if (end <= 0) continue;
      try {
        const cue = new VTTCue(Math.max(0, start), Math.max(0.05, end), c.text);
        // Sit the box a little up from the bottom edge like Netflix does, centred, never wider than 90%.
        cue.snapToLines = true; cue.line = cueLine.current; cue.position = 50; cue.positionAlign = 'center'; cue.align = 'center'; cue.size = 90;
        tt.addCue(cue);
      } catch { /* bad cue */ }
    }
    tt.mode = subCuesRef.current.length ? 'showing' : 'hidden';
  }, []);

  // ---- attach media ----
  const attach = useCallback((url: string, mode: PlayResponse['mode'], timeOffset: number, startLocal = 0, autoplay = true) => {
    const v = videoRef.current!;
    hlsOffsetRef.current = timeOffset;
    renderCues(offsetRef.current);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    const onReady = () => { if (startLocal > 0) v.currentTime = startLocal; if (autoplay) v.play().catch(() => undefined); };
    hlsRef.current = attachMedia(v, url, { native: mode === 'direct', onReady, onFail: fail });
  }, [renderCues, fail]);

  const startAt = useCallback(async (resp: PlayResponse, t: number) => {
    if (resp.mode !== 'direct' && t > 5 && resp.sessionId) {
      try {
        const r = await api.hlsSeek(resp.sessionId, t);
        sessionRef.current = r.sessionId;
        // The session starts at the keyframe before t; step forward to t itself.
        attach(r.url, resp.mode, r.timeOffset, Math.max(0, t - r.timeOffset));
        return;
      } catch { /* fall through and start from 0 */ }
    }
    attach(resp.url, resp.mode, 0, resp.mode === 'direct' ? t : 0);
  }, [attach]);

  // ---- init ----
  useEffect(() => {
    let dead = false;
    setErr(''); setErrInfo(null); setMarks([]); setPhase('loading'); setPlay(null); setBuffering(true); nextShown.current = false; setShowNext(false); setEnded(false);
    setStore({ lockRemote: null }); // local playback owns the media session now
    (async () => {
      try {
        const resp = await api.play({ infoHash: p.infoHash, fileIdx: p.fileIdx, target: target(), videoId: p.videoId, caps: caps() });
        if (dead) return;
        setPlay(resp);
        sessionRef.current = resp.sessionId || null;
        if (resp.probe?.duration) setDur(resp.probe.duration);
        const resumeFrom = retryFrom.current; retryFrom.current = null;
        let start = resumeFrom ?? p.t ?? 0;
        if (resumeFrom == null && p.t == null && p.videoId) {
          // Always resume where you were; "Start over" is one tap away.
          const prog = await api.progress(p.videoId).catch(() => null);
          if (dead) return;
          const at = resumePoint(prog);
          if (at != null) {
            start = at;
            setMarks([{ t: at, label: `Resumed at ${fmtTime(at)}` }]);
          }
        }
        setPhase('ready');
        await startAt(resp, start);
      } catch (e) {
        if (dead) return;
        const code = errorCode(e);
        const w = startWords(code);
        fail(w.msg, { hint: w.hint, detail: (e as Error).message, retry: true, code });
      }
    })();
    return () => { dead = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.infoHash, p.fileIdx, p.videoId, attempt]);

  const seekRef = useRef<((t: number) => Promise<void>) | null>(null);

  // ---- subtitles ---- (retry while the torrent is still loading its file list)
  useEffect(() => {
    let dead = false; let tries = 0; let timer: number | undefined;
    setSubs([]); setActiveSub(null); setSubsLoading(true); subSettled.current = false; subManual.current = false;
    let autoPicked = false;
    let wantId: string | undefined;   // the exact track you used last time, if it is not in the list yet
    // The choice remembered for this video comes first: the track itself, or "off" if you turned them off.
    const savedP = p.videoId && !p.magnet ? api.progress(p.videoId).catch(() => null) : Promise.resolve(null);
    const fetchSubs = () => {
      Promise.all([api.subs({ type: p.magnet ? undefined : p.type, videoId: p.magnet ? undefined : p.videoId, infoHash: p.infoHash, fileIdx: p.fileIdx }), savedP])
        .then(([r, saved]) => {
          if (dead) return;
          setSubs(r.tracks);
          if (!subSettled.current && saved?.subOffsetMs) setSubOffset(saved.subOffsetMs);
          // A pick in the menu while the list was still filling in wins over anything automatic.
          if (subManual.current) { autoPicked = true; wantId = undefined; }
          else if (saved?.subId === null) autoPicked = true;   // off, on purpose
          else if (saved?.subId) {
            const t = r.tracks.find((x) => x.id === saved.subId && x.available);
            if (t) { setActiveSub(t); autoPicked = true; wantId = undefined; } else wantId = saved.subId;
          }
          if (!autoPicked || wantId) {
            // Then your last choice of language, otherwise the first preferred language from Settings, when auto subtitles are on.
            const st = getStore().settings;
            const want = saved?.subLang || localStorage.getItem(LS_LANG) || ((st?.autoSubs ?? true) ? st?.subLangs?.[0] : undefined);
            if (want && !autoPicked) {
              const inLang = r.tracks.filter((x) => x.available && x.lang === want);
              const t = inLang.find((x) => x.recommended) || inLang.find((x) => x.hashMatch) || inLang[0];
              if (t) { setActiveSub(t); autoPicked = true; }
            }
          }
          // Only a real choice (a track, or off restored from last time) rides along with progress saves:
          // "nothing found yet" must not be saved as "off", nor overwrite the track remembered last time.
          if (autoPicked) subSettled.current = true;
          // keep polling a few times: torrent file list / embedded tracks fill in after load, and the remembered track may be one of them
          if (!dead && tries < 5 && (r.tracks.filter((x) => x.available).length < 1 || wantId)) { tries++; timer = window.setTimeout(fetchSubs, 4000); }
        })
        .catch(() => { if (!dead && tries < 5) { tries++; timer = window.setTimeout(fetchSubs, 4000); } })
        .finally(() => { if (!dead) setSubsLoading(false); });
    };
    fetchSubs();
    return () => { dead = true; if (timer) window.clearTimeout(timer); };
  }, [p.type, p.videoId, p.infoHash, p.fileIdx, p.magnet]);


  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const req = ++subReqRef.current;
    // hide any existing managed track immediately
    if (subTrackRef.current) { const tt = subTrackRef.current; if (tt.cues) for (const c of Array.from(tt.cues)) tt.removeCue(c); tt.mode = 'hidden'; }
    subCuesRef.current = [];
    if (!activeSub) { setSubApplying(false); return; }
    setSubApplying(true);
    fetch(activeSub.url)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((text) => {
        if (req !== subReqRef.current) return; // superseded
        subCuesRef.current = parseVtt(text);
        renderCues(offsetRef.current);
        for (const tt of Array.from(v.textTracks)) if (tt !== subTrackRef.current) tt.mode = 'disabled';
      })
      .catch(() => { if (req === subReqRef.current) toast('Could not load that subtitle, try another', 'error'); })
      .finally(() => { if (req === subReqRef.current) setSubApplying(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSub]);

  useEffect(() => { offsetRef.current = subOffset; renderCues(subOffset); }, [subOffset, renderCues]);
  // Auto-sync: the server listens to three minutes of audio around here and shifts the cues to match.
  const [syncBusy, setSyncBusy] = useState(false);
  const autoSync = async () => {
    if (!activeSub || !play) return;
    setSyncBusy(true);
    try {
      const r = await api.subSync({ id: activeSub.id, infoHash: p.infoHash, fileIdx: play.fileIdx, from: absTime() });
      setSubOffset(r.offsetMs);
      flash(r.score < 0.35 ? `Weak match, tried ${(r.offsetMs / 1000).toFixed(1)} s` : `Subtitles synced ${r.offsetMs >= 0 ? '+' : ''}${(r.offsetMs / 1000).toFixed(1)} s`);
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setSyncBusy(false); }
  };
  const pickSub = (t: SubtitleTrack | null) => {
    setActiveSub(t); subRef.current = t; subSettled.current = true; subManual.current = true;
    if (t) localStorage.setItem(LS_LANG, t.lang); else localStorage.removeItem(LS_LANG);
    saveRef.current();   // remembered for this video right away, not at the next ten-second tick
  };

  // ---- series: next episode ----
  useEffect(() => {
    if (p.type !== 'series' || !p.metaId || p.magnet) return;
    api.meta('series', p.metaId).then((r) => {
      setMeta(r.meta); setEpProgress(r.progress);
      const eps = sortedEpisodes(r.meta.videos || []).filter((e) => e.season > 0);
      const i = eps.findIndex((e) => e.id === p.videoId);
      const n = i >= 0 ? eps[i + 1] : undefined;
      setNext(n && (!n.released || new Date(n.released).getTime() <= Date.now()) ? n : null);
    }).catch(() => undefined);
  }, [p.type, p.metaId, p.videoId, p.magnet]);

  // Any episode of the show from the shelf, or the next one. Only moving on to the next one checks this one off and
  // starts it from the top; one picked from the shelf resumes where you left it.
  const playEpisode = useCallback(async (ep: Episode, opts: { next?: boolean; manual?: boolean } = {}) => {
    if (!meta) return;
    setShowNext(false); setEpsOpen(false);
    // A deliberate skip in the last twenty minutes teaches where this show's credits start.
    const d = totalDur(); const at = absTime();
    if (opts.next && opts.manual !== false && !p.magnet && d && d - at > 10 && d - at < 20 * 60) api.creditsLearn(p.metaId, d - at).catch(() => undefined);
    try {
      const r = await api.streams('series', ep.id, target());
      const src = episodeSource(r.sources, r.auto, sessionStorage.getItem('kino.binge'));
      if (!src) { toast(opts.next ? 'No sources for the next episode' : 'No sources for that episode', 'error'); navigate(titleUrl('series', p.metaId, ep.id)); return; }
      if (opts.next) movedOn.current = true;
      saveRef.current();
      navigate(playUrl({ type: 'series', videoId: ep.id, metaId: p.metaId, infoHash: src.infoHash, fileIdx: src.fileIdx, name: `${meta.name} S${ep.season} E${ep.episode} ${ep.title || ''}`.trim(), poster: meta.poster, background: ep.thumbnail || meta.background, season: ep.season, episode: ep.episode, t: opts.next ? 0 : undefined }), true);
    } catch (e) { toast((e as Error).message, 'error'); }
  }, [meta, p.metaId, p.magnet, totalDur, absTime]);
  const playNext = useCallback(async (manual = true) => { if (next) await playEpisode(next, { next: true, manual }); }, [next, playEpisode]);
  // Ask for the credits estimate once playback runs and there is a next episode to go to.
  useEffect(() => {
    if (!next || !play || p.magnet) return;
    let dead = false;
    api.credits({ infoHash: p.infoHash, fileIdx: play.fileIdx, videoId: p.videoId, metaId: p.metaId }).then((c) => { if (!dead) setCredits(c); }).catch(() => undefined);
    return () => { dead = true; };
  }, [next, play, p.infoHash, p.videoId, p.metaId, p.magnet]);

  // ---- skip intro: a chapter, or where you skipped the titles in an earlier episode of this show ----
  const introQ = useMemo((): IntroQuery | null => (p.type === 'series' && !p.magnet && p.metaId && play ? { infoHash: p.infoHash, fileIdx: play.fileIdx, videoId: p.videoId, metaId: p.metaId } : null), [p.type, p.magnet, p.metaId, p.infoHash, p.videoId, play]);
  const intro = useIntro(introQ);
  const introLearn = useIntroLearner(introQ);

  // ---- lock-screen / notification controls (MediaSession), like Spotify ----
  useEffect(() => {
    const nav = navigator as Navigator & { mediaSession?: MediaSession };
    if (!nav.mediaSession || typeof MediaMetadata === 'undefined') return;
    const art = p.poster || p.background;
    nav.mediaSession.metadata = new MediaMetadata({
      title: p.name || 'Kino',
      artist: p.type === 'series' && p.season != null ? `Season ${p.season}, Episode ${p.episode}` : 'Kino',
      album: 'Kino',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { nav.mediaSession!.setActionHandler(a, h); } catch { /* unsupported */ } };
    const v = () => videoRef.current;
    set('play', () => v()?.play());
    set('pause', () => v()?.pause());
    set('seekbackward', (d) => { const el = v(); if (el) el.currentTime = Math.max(0, el.currentTime - (d.seekOffset || 10)); });
    set('seekforward', (d) => { const el = v(); if (el) el.currentTime = el.currentTime + (d.seekOffset || 10); });
    set('seekto', (d) => { const el = v(); if (el && d.seekTime != null) el.currentTime = d.seekTime - hlsOffsetRef.current; });
    set('nexttrack', next ? () => void playNext() : null);
    return () => { for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack'] as MediaSessionAction[]) set(a, null); };
  }, [p.name, p.poster, p.background, p.type, p.season, p.episode, next, playNext]);

  // ---- progress ----
  const lastPos = useRef<{ pos: number; dur: number } | null>(null);
  // The last position seen on the timeline. React detaches videoRef before the unmount cleanup runs, so the
  // save on leaving reads this instead of the element (which is exactly the save that used to be lost).
  // Moved on to the next episode (at the credits, usually): from then on this one is saved as watched to the end.
  const movedOn = useRef(false);
  const saveProgress = useCallback((beacon = false) => {
    if (!p.videoId) return;
    const v = videoRef.current;
    const d = v ? totalDur() : lastPos.current?.dur ?? 0;
    const pos = movedOn.current && d > 0 ? d : v ? absTime() : lastPos.current?.pos ?? 0;
    if (pos < 5) return;
    const sub = subSettled.current ? { subId: subRef.current?.id ?? null, subLang: subRef.current?.lang, subOffsetMs: offsetRef.current } : {};
    const body = { videoId: p.videoId, metaId: p.metaId || p.videoId, type: (p.type as 'movie' | 'series'), pos, dur: d, name: p.name, poster: p.poster, background: p.background, season: p.season, episode: p.episode, infoHash: p.infoHash, fileIdx: p.fileIdx, ...sub };
    if (beacon) api.beaconProgress(body); else api.putProgress(body).catch(() => undefined);
    lastSave.current = Date.now();
  }, [p, absTime, totalDur]);
  const saveRef = useRef(saveProgress); saveRef.current = saveProgress;
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') saveProgress(true); };
    const onPageHide = () => saveProgress(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onPageHide); };
  }, [saveProgress]);
  // Keep the transcoder session alive while this player is open (paused players fetch nothing).
  useEffect(() => {
    const t = window.setInterval(() => { if (sessionRef.current) void api.hlsPing(sessionRef.current); }, 45_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => () => {
    // unmount cleanup
    saveRef.current(true);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (sessionRef.current) api.hlsClose(sessionRef.current);
    const v = videoRef.current; if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    setStore({ stats: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (p.infoHash) api.torrentStats(p.infoHash).then((s) => setStore({ stats: s })).catch(() => undefined); }, [p.infoHash]);

  // ---- video events ----
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    v.volume = volume; v.muted = muted;
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    const upd = () => {
      setCur(v.currentTime + hlsOffsetRef.current);
      lastPos.current = { pos: v.currentTime + hlsOffsetRef.current, dur: totalDur() };
      if (!play?.probe?.duration && isFinite(v.duration)) setDur(v.duration);
      const b: [number, number][] = [];
      for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i) + hlsOffsetRef.current, v.buffered.end(i) + hlsOffsetRef.current]);
      setBuffered(b);
      if (ms && 'setPositionState' in ms) { const dd = totalDur(); if (dd && isFinite(dd)) try { ms.setPositionState({ duration: dd, position: Math.min(dd, v.currentTime + hlsOffsetRef.current), playbackRate: v.playbackRate || 1 }); } catch { /* ignore */ } }
      if (playing && Date.now() - lastSave.current > 10000) saveProgress();
      const d = totalDur();
      const cr = creditsRef.current;
      const at = cr?.at != null && cr.confidence !== 'none' ? cr.at : d ? d - 30 : 0;
      if (next && d && v.currentTime + hlsOffsetRef.current >= at && !nextShown.current) { nextShown.current = true; setShowNext(true); }
    };
    const setPB = (st: MediaSessionPlaybackState) => { const m = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession; if (m) m.playbackState = st; };
    const onPlay = () => { setPlaying(true); setBuffering(false); setPB('playing'); };
    const onProgressOk = () => {
      if (v.currentTime > 15) autoRetries.current = 0;
      const w = watched.current; const d = v.currentTime - w.last;
      if (w.last >= 0 && d > 0 && d < 2 && !v.paused) w.sec += d;
      w.last = v.currentTime;
    };
    const onPause = () => { setPlaying(false); saveProgress(); setPB('paused'); };
    // A jump is a decision about where you are: save it now, not up to ten seconds later.
    const onSeeked = () => { upd(); saveProgress(); };
    const onSeeking = () => { lastSeekAt.current = Date.now(); };
    const onWait = () => setBuffering(true);
    const onCanPlay = () => setBuffering(false);
    const onEnded = () => {
      // "ended" well before the end is not the end: the transcoder died or the download ran dry.
      const d = totalDur(); const at = v.currentTime + hlsOffsetRef.current;
      if (d && d - at > 20) {
        if (play?.mode === 'direct') outcomeRef.current('ended-early');   // the download ran dry
        const w = endedEarlyWords(play?.mode === 'direct');
        fail(w.msg, { hint: w.hint, detail: endedEarlyDetail(at, d, statsRef.current), retry: true });
        return;
      }
      setPlaying(false); setEnded(true); saveProgress(); if (next && !nextShown.current) { nextShown.current = true; setShowNext(true); }
    };
    const onErr = () => {
      const e = v.error; if (!e || err || e.code === 1) return;
      const w = e.code === 2 ? MEDIA.lost : e.code === 3 ? MEDIA.broken : MEDIA.format;
      fail(w.msg, { hint: w.hint, detail: e.message, retry: e.code === 2 });
    };
    v.addEventListener('timeupdate', onProgressOk); v.addEventListener('timeupdate', upd); v.addEventListener('progress', upd); v.addEventListener('durationchange', upd);
    v.addEventListener('play', onPlay); v.addEventListener('playing', onPlay); v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWait); v.addEventListener('canplay', onCanPlay); v.addEventListener('ended', onEnded); v.addEventListener('error', onErr); v.addEventListener('seeked', onSeeked); v.addEventListener('seeking', onSeeking);
    return () => {
      v.removeEventListener('seeked', onSeeked); v.removeEventListener('seeking', onSeeking);
      v.removeEventListener('timeupdate', onProgressOk); v.removeEventListener('timeupdate', upd); v.removeEventListener('progress', upd); v.removeEventListener('durationchange', upd);
      v.removeEventListener('play', onPlay); v.removeEventListener('playing', onPlay); v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWait); v.removeEventListener('canplay', onCanPlay); v.removeEventListener('ended', onEnded); v.removeEventListener('error', onErr);
    };
  }, [play, playing, next, err, volume, muted, saveProgress, totalDur, fail]);

  // The server knows when a transcoder dies. Without this the player would just sit there.
  useEffect(() => onSse('hls.state', (st) => {
    if (st.state !== 'error' || st.sessionId !== sessionRef.current) return;
    const w = stoppedWords(st.code);
    fail(w.msg, { hint: w.hint, detail: st.error, retry: true, code: st.code });
  }), [fail]);

  // ---- actions ----
  const seekTo = useCallback(async (t: number) => {
    const v = videoRef.current; if (!v || !play) return;
    lastSeekAt.current = Date.now();
    const d = totalDur();
    t = Math.max(0, Math.min(t, d ? d - 1 : t));
    // Big jump backwards (a stray tap on the seek bar): remember where you were.
    const from = absTime();
    if (from > 90 && from - t > 60) addMark({ t: from, label: `You were at ${fmtTime(from)}` });
    if (play.mode === 'direct') { v.currentTime = t; return; }
    const local = t - hlsOffsetRef.current;
    const seekable = v.seekable;
    let ok = false;
    for (let i = 0; i < seekable.length; i++) if (local >= seekable.start(i) && local <= seekable.end(i)) ok = true;
    if (!ok && hlsRef.current) {
      const h = hlsRef.current.hls;
      const details = h?.levels?.[h.currentLevel]?.details;
      if (details && local >= 0 && local <= details.totalduration) ok = true;
    }
    if (ok && local >= 0) { v.currentTime = local; return; }
    if (!sessionRef.current) return;
    setBuffering(true);
    try {
      const r = await api.hlsSeek(sessionRef.current, t);
      sessionRef.current = r.sessionId;
      attach(r.url, play.mode, r.timeOffset, Math.max(0, t - r.timeOffset));
      setCur(t);
    } catch (e) { toast(toastWords(errorCode(e), (e as Error).message), 'error'); setBuffering(false); }
  }, [play, attach, totalDur, absTime, showNotice]);
  useEffect(() => { seekRef.current = seekTo; }, [seekTo]);
  const skip = useCallback((d: number) => seekTo(absTime() + d), [seekTo, absTime]);
  const togglePlay = useCallback(() => { const v = videoRef.current; if (!v) return; if (v.paused) v.play().catch(() => undefined); else v.pause(); }, []);
  const setVol = (x: number) => { setVolume(x); setMuted(false); localStorage.setItem(LS_VOL, String(x)); };
  const toggleMute = () => setMuted((m) => !m);

  // ---- HUD + shortcuts: every action says what it did and which key does it ----
  const { hud, flash } = useHud();
  const [keysOpen, setKeysOpen] = useState(false);
  // Any open sheet owns the keyboard and keeps the controls up. The key listener reads the ref, so it never sees a stale set.
  const sheets: PlayerSheets = { keys: keysOpen, subs: subMenu, cast: castOpen || destOpen, sources: !!srcOpen, audio: audioOpen, sleep: sleepOpen, stall: !!stall, episodes: epsOpen };
  const sheetOpen = anyPlayerSheet(sheets);
  const sheetsRef = useRef(sheets); sheetsRef.current = sheets;
  const showNudge = useShortcutNudge();
  const lastSub = useRef<SubtitleTrack | null>(null);
  useEffect(() => { if (activeSub) lastSub.current = activeSub; }, [activeSub]);
  const playPause = useCallback(() => { const v = videoRef.current; flash(v?.paused ? 'Play' : 'Pause', 'K'); togglePlay(); }, [flash, togglePlay]);
  const skipH = (d: number, key?: string) => { introLearn.onJump(absTime(), absTime() + d); flash(`${d > 0 ? '+' : '−'}${Math.abs(d) >= 60 ? `${Math.abs(d) / 60} min` : `${Math.abs(d)} s`}`, key); skip(d); };
  const muteH = () => { flash(muted ? 'Sound on' : 'Muted', 'M'); toggleMute(); };
  const volH = (x: number, key?: string) => { const v = Math.round(Math.min(1, Math.max(0, x)) * 100) / 100; flash(`Volume ${Math.round(v * 100)}%`, key); setVol(v); };
  const speedH = (dir: 1 | -1) => {
    const v = videoRef.current; if (!v) return;
    const steps = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const i = Math.max(0, Math.min(steps.length - 1, steps.findIndex((x) => x >= v.playbackRate - 0.01) + dir));
    v.playbackRate = steps[i]; flash(steps[i] === 1 ? 'Normal speed' : `${steps[i]}×`, dir > 0 ? '>' : '<');
  };
  const frameH = (dir: 1 | -1) => { const v = videoRef.current; if (!v || !v.paused) return; v.currentTime = Math.max(0, v.currentTime + dir / 24); flash(dir > 0 ? 'Next frame' : 'Previous frame', dir > 0 ? '.' : ','); };
  const toggleSubsH = () => {
    if (activeSub) { flash('Subtitles off', 'V'); pickSub(null); return; }
    const t = lastSub.current && subs.find((x) => x.id === lastSub.current!.id && x.available) || subs.find((x) => x.available && /^en/.test(x.lang || '')) || subs.find((x) => x.available);
    if (t) { flash(`Subtitles: ${langName(t.lang || 'und')}`, 'V'); pickSub(t); } else flash('No subtitles available', 'V');
  };
  // A seek you make on the bar may be you skipping the titles; resume points and marks are not.
  const userSeek = (t: number) => { introLearn.onJump(absTime(), t); void seekTo(t); };
  const showIntro = phase === 'ready' && !err && inIntro(intro, cur);
  const skipIntro = () => { if (!intro?.end) return; introLearn.reset(); flash('Skipped the intro', 'I'); void seekTo(intro.end); };
  const nextH = () => { if (next) { flash(`Next: S${next.season} E${next.episode}`, 'N'); void playNext(); } else flash('No next episode', 'N'); };
  const jumpH = (tenth: number) => { const d = totalDur(); if (!d) return; flash(tenth ? `${tenth * 10}%` : 'Start', String(tenth)); void seekTo(d * tenth / 10); };
  const fullH = () => { flash('Fullscreen', 'F'); fullscreen(); };
  const pipH = () => { flash('Picture in picture', 'P'); pip(); };
  const fullscreen = () => {
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const w = wrapRef.current;
    if (isIOS && v?.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else { w?.requestFullscreen?.().then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined)).catch(() => undefined); }
  };
  // AirPlay: Safari only (iPhone, iPad, Mac). The LG TV speaks AirPlay 2, not Google Cast,
  // so this is how it gets Kino without the Chromecast dongle. Works with native HLS/direct play.
  const airplaySupported = 'WebKitPlaybackTargetAvailabilityEvent' in window;
  const airplay = () => { const v = videoRef.current as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | null; v?.webkitShowPlaybackTargetPicker?.(); };
  const pipSupported = !!document.pictureInPictureEnabled || typeof (document.createElement('video') as unknown as Record<string, unknown>).webkitSetPresentationMode === 'function';
  const pip = () => {
    const v = videoRef.current as (HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string }) | null;
    if (!v) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => undefined);
    else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => undefined);
    else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  };
  // Like every cast button: the lock-screen remote arms inside this tap (sendToTv), then the TV takes over and this
  // screen turns into its remote, same route, so Back still leads where it did.
  const castTo = async (d: Tv) => {
    videoRef.current?.pause();
    setSending(d.id);
    const infoHash = castSrc?.infoHash || p.infoHash;
    const fileIdx = castSrc ? (castSrc.fileIdx ?? -1) : (p.fileIdx ?? play?.fileIdx ?? 0);
    const start = async (deviceId: string) => setStore({ cast: await api.castPlay({ deviceId, infoHash, fileIdx, videoId: p.videoId, title: p.name, poster: p.poster, startTime: absTime(), subId: castSrc ? undefined : activeSub?.id ?? null, subOffsetMs: subOffset }) });
    const ok = await sendToTv(d, start, `Playing on ${d.name}`);
    setSending(null);
    if (!ok) return;
    setCastOpen(false); setDestOpen(false);
    saveProgress(true);
    navigate(playUrl({ ...p, infoHash, fileIdx: castSrc ? castSrc.fileIdx : p.fileIdx, t: undefined, tv: true }), true);
  };
  const leave = () => { saveProgress(true); if (p.magnet) leaveTo('/magnet'); else if (p.metaId) leaveTo(titleUrl(p.type, p.metaId, p.type === 'series' ? p.videoId : undefined)); else back('/'); };

  // ---- stall detection: say why, offer a way out ----
  const diagnose = useCallback(() => stallWords(play, stats), [stats, play]);
  useEffect(() => {
    if (phase !== 'ready' || err || stall || !buffering || Date.now() < stallSnooze.current) return;
    const t = window.setTimeout(() => {
      const v = videoRef.current;
      if (!v || (play && v.paused && v.currentTime > 0)) return;   // user paused, not a stall
      setStall(diagnose());
      outcomeRef.current('stall');
    }, play ? 18_000 : 35_000);
    return () => window.clearTimeout(t);
  }, [buffering, phase, err, stall, play, diagnose]);
  const currentSourceId = `${p.infoHash}:${p.fileIdx ?? -1}`;
  const switchSource = async () => {
    setStallBusy(true);
    try {
      const r = await api.streams(p.type, p.videoId, target());
      const alt = r.sources.find((s) => s.id !== currentSourceId && s.score > 0) || r.sources.find((s) => s.id !== currentSourceId);
      if (!alt) { toast('No other sources for this one', 'error'); leave(); return; }
      outcome('switch');
      toast(`Switching to ${alt.provider || alt.addon} ${alt.resolution && alt.resolution !== 'other' ? alt.resolution : ''}`.trim());
      navigate(playUrl({ type: p.type, videoId: p.videoId, metaId: p.metaId, infoHash: alt.infoHash, fileIdx: alt.fileIdx, name: p.name, poster: p.poster, background: p.background, season: p.season, episode: p.episode, t: Math.max(0, absTime()) }), true);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setStallBusy(false); }
  };
  const switchTo = (alt: Source) => {
    outcome('switch');
    toast(`Switching to ${alt.provider || alt.addon}${alt.resolution && alt.resolution !== 'other' ? ` ${alt.resolution}` : ''}`);
    navigate(playUrl({ type: p.type, videoId: p.videoId, metaId: p.metaId, infoHash: alt.infoHash, fileIdx: alt.fileIdx, name: p.name, poster: p.poster, background: p.background, season: p.season, episode: p.episode, t: Math.max(0, absTime()) }), true);
  };
  const downloadSource = async (s: Source) => {
    try {
      await api.addDownload({ infoHash: s.infoHash, fileIdx: s.fileIdx, videoId: p.videoId, metaId: p.metaId, type: p.type as 'movie' | 'series', name: p.name, poster: p.poster, background: p.background });
      toast('Downloading for later. It shows up on Home when ready.', 'info', 5000);
    } catch (e) { toast((e as Error).message, 'error', 6000); }
  };
  // Soft nudge well before the stall sheet: three rebuffers in two minutes, or a
  // download that cannot keep up with the file's bitrate while we are playing.
  useEffect(() => {
    if (!buffering || phase !== 'ready' || !play || !videoRef.current || videoRef.current.currentTime < 5) return;
    if (Date.now() - lastSeekAt.current < 10_000) return;   // you jumped: the wait is the jump, not stutter
    const now = Date.now();
    rebuffers.current = [...rebuffers.current.filter((t) => now - t < 120_000), now];
    if (rebuffers.current.length >= 3 && now - weakNudged.current > 180_000 && !stall && !srcOpen && !p.magnet && p.videoId) {
      weakNudged.current = now;
      const w = stutterWords(p.type === 'series');
      showNotice({ text: w.text, action: { label: 'Switch source', run: () => { setNotice(null); setSrcOpen({ reason: w.reason }); } } }, 15000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffering]);
  useEffect(() => {
    if (!playing || !stats || !play || p.magnet || !p.videoId) return;
    const need = play.sizeBytes && play.probe?.duration ? play.sizeBytes / play.probe.duration : 0;
    if (!need) return;
    const slow = stats.numPeers === 0 || stats.downloadSpeed < need * 0.7;
    if (!slow || stats.progress >= 0.999) return;
    const t = window.setTimeout(() => {
      if (Date.now() - weakNudged.current < 180_000 || stall || srcOpen) return;
      weakNudged.current = Date.now();
      const w = slowWords(stats.numPeers, stats.downloadSpeed, need);
      showNotice({ text: w.text, action: { label: 'Switch source', run: () => { setNotice(null); setSrcOpen({ reason: w.reason }); } } }, 15000);
    }, 25_000);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, stats?.downloadSpeed, stats?.numPeers]);
  // Change audio track: the server remuxes with that track (direct only if it is the first one).
  const audioTracks = play?.probe?.audio || [];
  const pickAudio = async (index: number) => {
    if (!play || index === play.audioIndex) { setAudioOpen(false); return; }
    setAudioBusy(true);
    const at = absTime();
    try {
      if (sessionRef.current) { void api.hlsClose(sessionRef.current); sessionRef.current = null; }
      const resp = await api.play({ infoHash: p.infoHash, fileIdx: p.fileIdx, target: target(), videoId: p.videoId, caps: caps(), audioTrack: index });
      setPlay(resp);
      sessionRef.current = resp.sessionId || null;
      setBuffering(true);
      await startAt(resp, at);
      setAudioOpen(false);
      const t = resp.probe?.audio.find((a) => a.index === index);
      toast(`Audio: ${t ? langName(t.lang || 'und') : 'track ' + index}`);
    } catch (e) { toast(toastWords(errorCode(e), (e as Error).message), 'error'); } finally { setAudioBusy(false); }
  };
  const downloadLater = async () => {
    setStallBusy(true);
    try {
      await api.addDownload({ infoHash: p.infoHash, fileIdx: p.fileIdx, videoId: p.magnet ? undefined : p.videoId, metaId: p.magnet ? undefined : p.metaId, type: p.type as 'movie' | 'series', name: p.name, poster: p.poster, background: p.background });
      toast('Downloading in the background. It shows up on Home when ready.', 'info', 5000);
      leave();
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setStallBusy(false); }
  };

  // ---- "Cast to the TV instead?" nudge, once per TV per browser session: the Cast button pulses for a few seconds ----
  useEffect(() => { if (!castPulse) return; const t = window.setTimeout(() => setCastPulse(null), 6000); return () => window.clearTimeout(t); }, [castPulse]);
  useEffect(() => {
    if (phase !== 'ready' || !playing || err) return;
    const tv = (receivers || []).find((r) => r.online && !r.audioOnly && !r.kino && !(r.media && r.media.state === 'PLAYING'));
    if (!tv) return;
    const key = `kino.nudge.${tv.id}`;
    if (sessionStorage.getItem(key)) return;
    const t = window.setTimeout(() => {
      if (!videoRef.current || videoRef.current.paused) return;
      sessionStorage.setItem(key, '1');
      setCastPulse(tv.name);
    }, 20000);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, playing, receivers?.length]);

  // ---- controls visibility ----
  const poke = useCallback(() => {
    setShowCtl(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!videoRef.current?.paused && !sheetOpen) setShowCtl(false); }, 3000);
  }, [sheetOpen]);
  useEffect(() => { poke(); }, [poke, playing]);
  const onWrapClick = (e: RMouseEvent) => {
    if (onPlayerChrome(e.target, ', .pnotice, .countdown, .skip-intro')) return;
    if (isTouch) {
      // Double tap on the left or right third skips 10 s, like every mobile player.
      const now = Date.now(); const x = e.clientX / window.innerWidth;
      const prev = lastTap.current; lastTap.current = { t: now, x };
      if (now - prev.t < 350 && Math.abs(prev.x - x) < 0.15 && (x < 0.34 || x > 0.66)) {
        const d = x < 0.34 ? -10 : 10;
        introLearn.onJump(absTime(), absTime() + d);
        void skip(d);
        showNotice({ text: d < 0 ? '−10 s' : '+10 s' }, 800);
        lastTap.current = { t: 0, x };
        return;
      }
      if (showCtl) setShowCtl(false); else poke();
    } else { playPause(); poke(); }
  };
  // Double click toggles fullscreen, also over the visible controls. Its two clicks already toggled play twice, so playback carries on.
  const onWrapDbl = (e: RMouseEvent) => {
    // The big play button sits where people double click; it counts as the video (its two clicks cancel out).
    if (isTouch || (onPlayerChrome(e.target, ', .pnotice, .countdown, .skip-intro') && !(e.target as HTMLElement).closest('.iconbtn.huge'))) return;
    fullH();
  };
  // sleep timer countdown
  const sleepUntil = sleep && sleep !== 'episode' ? sleep.until : null;
  useEffect(() => {
    if (sleepUntil == null) { setSleepMs(0); return; }
    const tick = () => {
      const left = sleepUntil - Date.now();
      setSleepMs(Math.max(0, left));
      if (left <= 0) {
        setSleep(null);
        videoRef.current?.pause();
        showNotice({ text: 'Sleep timer: paused', action: { label: 'Keep watching', run: () => { setNotice(null); videoRef.current?.play().catch(() => undefined); } } }, 60_000);
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepUntil]);
  const pickSleep = (c: SleepChoice) => { const s = startSleep(c); setSleep(s); setSleepMs(sleepLeft(s)); setSleepOpen(false); };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const route = playerKeyRoute(e, (e.target as HTMLElement | null)?.tagName, sheetsRef.current, getStore());
      if (route === 'close-keys') { e.preventDefault(); setKeysOpen(false); }
      if (route !== 'player') return;
      const k = e.key;
      const stop = () => { e.preventDefault(); poke(); };
      if (k === ' ' || k === 'k' || k === 'K') { playPause(); stop(); }
      else if (k === 'ArrowLeft') { skipH(e.shiftKey ? -60 : -10, e.shiftKey ? '⇧ ←' : '←'); stop(); }
      else if (k === 'ArrowRight') { skipH(e.shiftKey ? 60 : 10, e.shiftKey ? '⇧ →' : '→'); stop(); }
      else if (k === 'j' || k === 'J') { skipH(-10, 'J'); stop(); }
      else if (k === 'l' || k === 'L') { skipH(10, 'L'); stop(); }
      else if (/^[0-9]$/.test(k)) { jumpH(Number(k)); stop(); }
      else if (k === 'f' || k === 'F') { fullH(); stop(); }
      else if (k === 'm' || k === 'M') { muteH(); stop(); }
      else if (k === 'p' || k === 'P') { pipH(); stop(); }
      else if (k === 'c' || k === 'C') { setSubMenu(true); stop(); }
      else if (k === 'v' || k === 'V') { toggleSubsH(); stop(); }
      else if (k === 'n' || k === 'N') { nextH(); stop(); }
      else if ((k === 'i' || k === 'I') && showIntro) { skipIntro(); stop(); }
      else if (k === 't' || k === 'T') { setDestOpen(true); stop(); }
      else if ((k === 's' || k === 'S') && !p.magnet && p.videoId) { setSrcOpen({}); stop(); }
      else if ((k === 'a' || k === 'A') && audioTracks.length > 1) { setAudioOpen(true); stop(); }
      else if (k === 'ArrowUp') { volH(volume + 0.1, '↑'); stop(); }
      else if (k === 'ArrowDown') { volH(volume - 0.1, '↓'); stop(); }
      else if (k === '<') { speedH(-1); stop(); }
      else if (k === '>') { speedH(1); stop(); }
      else if (k === ',') { frameH(-1); stop(); }
      else if (k === '.') { frameH(1); stop(); }
      else if (k === '[' || k === '{') { const d = k === '{' ? 1000 : 100; setSubOffset((o) => { flash(`Subtitles ${(o - d) / 1000 >= 0 ? '+' : ''}${((o - d) / 1000).toFixed(1)} s`, k === '{' ? '⇧ [' : '['); return o - d; }); stop(); }
      else if (k === ']' || k === '}') { const d = k === '}' ? 1000 : 100; setSubOffset((o) => { flash(`Subtitles ${(o + d) / 1000 >= 0 ? '+' : ''}${((o + d) / 1000).toFixed(1)} s`, k === '}' ? '⇧ ]' : ']'); return o + d; }); stop(); }
      else if (k === '?') { setKeysOpen(true); stop(); }
      else if (k === 'Escape') { leave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playPause, skip, volume, muted, poke, next, subs, activeSub, showIntro, intro]);

  // How it reaches this screen, after the episode code: plain words first, the codec for the curious.
  const how = play ? `${play.mode === 'direct' ? 'Direct' : play.mode === 'hls-copy' ? 'Remuxed' : 'Transcoded'}${play.probe?.video ? ` · ${play.probe.video.codec.toUpperCase()}${play.probe.video.height ? ` ${play.probe.video.height}p` : ''}` : ''}` : undefined;
  // An episode reads as the TV app sets it: the show small over the episode's own title, then where it sits.
  const named = splitShowName(p.name);
  const epTitle = p.type === 'series' && p.season != null ? (meta?.videos?.find((v) => v.id === p.videoId)?.title || named.episode) : '';
  const kicker = epTitle ? meta?.name || named.show : undefined;
  const heading = epTitle || p.name;
  const where = p.type === 'series' && p.season != null ? `Season ${p.season}, Episode ${p.episode}` : '';
  const subtitleLine = [where, how].filter(Boolean).join(' · ') || undefined;
  usePullDown(wrapRef, leave, isTouch && !err && !sheetOpen);
  // Subtitles sit at the foot of the picture (the video box is the picture's size, player.css). They step up out of the
  // way while the controls show over it, and stay put where the controls are below it (a phone held upright). Measured
  // again whenever the picture changes size: turned, rotated by the Landscape button, a window resized.
  useEffect(() => {
    const v = videoRef.current, w = wrapRef.current; if (!v || !w) return;
    const place = () => {
      const turned = w.hasAttribute('data-rotated');
      const pic = v.getBoundingClientRect();
      const foot = w.querySelector('.pc-bottom')?.getBoundingClientRect();
      const line = cueLineFor(showCtl, turned || !foot || foot.top < pic.bottom - 4, turned ? pic.width : pic.height);
      if (line === cueLine.current) return;
      cueLine.current = line;
      const tt = subTrackRef.current; if (!tt?.cues || tt.mode !== 'showing') return;
      for (const c of Array.from(tt.cues)) { try { (c as VTTCue).line = line; } catch { /* read-only cue */ } }
      tt.mode = 'hidden'; tt.mode = 'showing';   // a cue on screen is only laid out again when it is drawn again
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place); ro.observe(v);
    return () => ro.disconnect();
  }, [showCtl]);
  const dest = (
    <PlayOn open={destOpen} onOpen={() => { setDestOpen(true); setCastPulse(null); }} onClose={() => setDestOpen(false)} deviceId={null} busy={sending} pulse={!!castPulse}
      onTv={(d) => void castTo(d)} onAirplay={airplaySupported ? airplay : undefined} />
  );

  return (
    <div className={`player${showCtl ? '' : ' hide-cursor'}`} ref={wrapRef} onClick={onWrapClick} onDoubleClick={onWrapDbl} onPointerMove={() => poke()} onTouchStart={() => { /* handled in click */ }}>
      {/* 100% = what used to be 70% on desktop: big screens sit further away than the old scale assumed */}
      {/* The browser scales cues with the picture, so a phone held upright would get tiny ones: never under 13px. */}
      <style>{`.player video::cue{font-size:max(13px, ${subSize / 100 * (isIOS ? 1.35 : 1.12)}em)}`}</style>
      <video ref={videoRef} playsInline crossOrigin="anonymous" preload="auto" poster={p.background || undefined} x-webkit-airplay="allow" />
      {(phase === 'loading' || buffering || !play) && !err ? (
        <div className={`pcenter${phase === 'loading' ? ' loading' : ''}`} style={phase === 'loading' && p.background ? { ['--art' as string]: `url("${p.background}")` } : undefined}>
          <div className="spinner" />
          <div className="msg">{waitWords(phase === 'loading', play, stats)}</div>
          {phase === 'loading' ? <div className="msg dim">{p.name}</div> : null}
          {phase === 'loading' ? <button className="btn glass pcenter-cancel" onClick={(e) => { e.stopPropagation(); leave(); }}>Cancel</button> : null}
        </div>
      ) : null}
      {stats && (showCtl || buffering) ? <TorrentStats s={stats} /> : null}
      {notice && !err ? (
        <div className="pnotice" onClick={(e) => e.stopPropagation()}>
          <span>{notice.text}</span>
          {notice.action ? <button className="btn small primary" onClick={notice.action.run}>{notice.action.label}</button> : null}
          <button className="pnotice-x" aria-label="Dismiss" onClick={() => setNotice(null)}><IconX /></button>
        </div>
      ) : null}
      {err ? (
        <div className="perror" onClick={(e) => e.stopPropagation()}>
          <strong>Playback stopped</strong>
          <p>{err}</p>
          {errInfo?.hint ? <p className="perror-hint">{errInfo.hint}</p> : null}
          {errInfo?.detail ? <code className="perror-detail">{errInfo.detail}</code> : null}
          <div className="perror-actions">
            {errInfo?.retry ? <button className="btn primary" onClick={retry}>Try again</button> : null}
            {!p.magnet && p.videoId ? <button className={`btn${errInfo?.retry ? '' : ' primary'}`} onClick={() => setSrcOpen({ reason: err })}>Switch source</button> : <button className={`btn${errInfo?.retry ? '' : ' primary'}`} onClick={leave}>Choose another source</button>}
            <button className="btn" onClick={() => setCastOpen(true)}>Play on a TV</button>
          </div>
        </div>
      ) : null}
      {phase === 'ready' && !err ? (
        <div className={`ctl-layer${showCtl || destOpen ? '' : ' hidden'}`}>
          {castPulse && !showCtl ? <button className="pc-circle cast-ghost cast-pulse" aria-label={`${castPulse} is on. Play there`} title={`${castPulse} is on`} onClick={() => { poke(); setDestOpen(true); setCastPulse(null); }}><IconCast /></button> : null}
          {showNudge ? <div className="key-nudge">Press <kbd className="keycap">?</kbd> for keyboard shortcuts</div> : null}
          <Controls title={heading} kicker={kicker} subtitle={subtitleLine} playing={playing} cur={cur} dur={totalDur()} buffered={buffered} marks={marks} volume={volume} muted={muted} subsOn={!!activeSub} dest={dest}
            onPlayPause={playPause} onSeek={userSeek} onSkip={(d) => skipH(d, d > 0 ? 'L' : 'J')} onVolume={setVol} onMute={muteH} onSubs={() => setSubMenu(true)} onFull={fullH} onPip={pipSupported ? pipH : undefined} onKeys={() => setKeysOpen(true)}
            onBack={leave} onSources={!p.magnet && p.videoId ? () => setSrcOpen({}) : undefined} onAudio={audioTracks.length > 1 ? () => setAudioOpen(true) : undefined} onSleep={() => setSleepOpen(true)} sleepLabel={sleepBadge(sleep, sleepMs)} sleepTitle={sleepWords(sleep, sleepMs)}
            onNext={next ? () => void playNext() : undefined} nextLabel={next ? `Next: S${next.season} E${next.episode}` : undefined} onEpisodes={meta?.videos?.length ? () => setEpsOpen(true) : undefined} />
        </div>
      ) : null}
      {showIntro ? <SkipIntroButton onSkip={skipIntro} className={showCtl ? 'lifted' : ''} /> : null}
      {showNext && next && settings ? <Countdown next={next} seconds={settings.autoNextDelaySec} credits={!ended && !!credits?.at && credits.confidence !== 'none'} auto={settings.autoNext && sleep !== 'episode' && (ended || (!!credits?.at && (credits.confidence === 'high' || credits.confidence === 'medium')))} onPlay={(manual) => void playNext(manual)} onCancel={() => setShowNext(false)} /> : null}
      {meta ? <EpisodesShelf meta={meta} progress={epProgress} current={p.videoId} open={epsOpen} onPick={(e) => { if (e.id === p.videoId) setEpsOpen(false); else void playEpisode(e); }} onClose={() => setEpsOpen(false)} /> : null}
      <Hud hud={hud} />
      {keysOpen ? <ShortcutsSheet onClose={() => setKeysOpen(false)} /> : null}
      {subMenu ? <SubtitleMenu tracks={subs} active={activeSub?.id} offsetMs={subOffset} size={subSize} loading={subsLoading} applying={subApplying} onPick={pickSub} onOffset={setSubOffset} onAuto={p.magnet ? undefined : autoSync} autoBusy={syncBusy} onSize={(s) => { setSubSize(s); api.putSettings({ subFontSize: s }).then((v) => setStore({ settings: v })).catch(() => undefined); }} onClose={() => setSubMenu(false)} /> : null}
      {castOpen ? <CastPicker onPick={castTo} busy={!!sending} onClose={() => { setCastOpen(false); setCastSrc(null); }} /> : null}
      {sleepOpen ? (
        <Sheet title="Sleep timer" onClose={() => setSleepOpen(false)} side>
          <p className="hint">Pause playback later, so falling asleep does not cost you three episodes.</p>
          {SLEEP_CHOICES.map(({ label, choice }) => (
            <button key={label} className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => pickSleep(choice)}><span className="grow">{label}</span>{sleepPicked(sleep, choice) ? <span className="chip accent">On</span> : null}</button>
          ))}
        </Sheet>
      ) : null}
      {audioOpen ? (
        <Sheet title="Audio track" onClose={() => setAudioOpen(false)} side>
          <p className="hint">This file has {audioTracks.length} audio tracks. Playback continues from where you are.</p>
          {audioTracks.map((a) => (
            <button key={a.index} className="row" style={{ width: '100%', textAlign: 'left' }} disabled={audioBusy} onClick={() => void pickAudio(a.index)}>
              <span className="grow">{langName(a.lang || 'und')}{a.title ? ` · ${a.title}` : ''}{audioDetail(a.codec, a.channels) ? <small>{audioDetail(a.codec, a.channels)}</small> : null}</span>
              {play?.audioIndex === a.index ? (audioBusy ? <span className="spinner sm" /> : <span className="chip accent">On</span>) : null}
            </button>
          ))}
        </Sheet>
      ) : null}
      {srcOpen ? <SourcesSheet type={p.type} videoId={p.videoId} currentId={currentSourceId} reason={srcOpen.reason} onPick={switchTo} onCast={(s) => { setSrcOpen(false); setCastSrc(s); setCastOpen(true); }} onDownload={downloadSource} onClose={() => setSrcOpen(false)} /> : null}
      {stall ? <StallSheet reason={stall.reason} hint={stall.hint} canSwitch={!p.magnet && !!p.videoId} canDownload busy={stallBusy}
        onSwitch={switchSource} onDownload={downloadLater} onPick={leave}
        onWait={() => { stallSnooze.current = Date.now() + 90_000; setStall(null); }} onClose={() => { stallSnooze.current = Date.now() + 90_000; setStall(null); }} /> : null}
    </div>
  );
}
