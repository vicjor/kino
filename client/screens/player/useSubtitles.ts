import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayResponse, Settings, SubtitleTrack } from '../../../server/types.js';
import { api } from '../../lib/api';
import { getStore, setStore, toast } from '../../lib/store';
import { langName, units, offsetLabel } from '../../lib/format';
import { parseVtt, cueLineFor, type Cue } from '../../lib/vtt';
import { bestInLang, subToTurnOn } from '../../lib/playback';
import type { PlayParams } from '../../lib/router';

const LS_LANG = 'kino.subLang';

/**
 * Render subtitles from JS-managed cues instead of a <track> element: the video never reloads, hls.js never fights a
 * native track, and the fetch happens in the background while playback continues. Cue times are absolute (file time);
 * an HLS session's timeline starts at hlsOffset, so shift them back by it.
 */
export function useCueTrack(videoRef: RefObject<HTMLVideoElement | null>, hlsOffsetRef: RefObject<number>) {
  const subTrackRef = useRef<TextTrack | null>(null);
  const subCuesRef = useRef<Cue[]>([]);
  const offsetRef = useRef(0);   // subtitle time offset (ms)
  const cueLine = useRef(-6);   // a few lines up while the controls show, nearer the edge when they go (useCuePlacement)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { subTrackRef, subCuesRef, offsetRef, cueLine, renderCues };
}
type CueTrack = ReturnType<typeof useCueTrack>;

/**
 * Subtitles sit at the foot of the picture (the video box is the picture's size, player.css). They step up out of the
 * way while the controls show over it, and stay put where the controls are below it (a phone held upright). Measured
 * again whenever the picture changes size: turned, rotated by the Landscape button, a window resized.
 */
export function useCuePlacement(videoRef: RefObject<HTMLVideoElement | null>, wrapRef: RefObject<HTMLDivElement | null>, cue: CueTrack, showCtl: boolean) {
  const { cueLine, subTrackRef } = cue;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCtl]);
}

interface SubsArgs {
  p: PlayParams;
  videoRef: RefObject<HTMLVideoElement | null>;
  cue: CueTrack;
  settings: Settings | null;
  play: PlayResponse | null;
  absTime: () => number;
  flash: (text: string, key?: string) => void;
  saveRef: RefObject<(beacon?: boolean) => void>;
}

/**
 * The subtitle list for this file and the one in use: the choice remembered for this video, else your language,
 * fetched and drawn as cues; the timing offset, auto-sync and size. The choice rides along with every progress save
 * (`subRef`, `subSettled`) once the list has loaded and a choice (or "off") is settled.
 */
export function useSubtitles(a: SubsArgs) {
  const { p, videoRef, cue, settings, play, absTime, flash, saveRef } = a;
  const { subTrackRef, subCuesRef, offsetRef, renderCues } = cue;
  const subReqRef = useRef(0);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subApplying, setSubApplying] = useState(false);
  const [activeSub, setActiveSub] = useState<SubtitleTrack | null>(null);
  const subRef = useRef<SubtitleTrack | null>(null); subRef.current = activeSub;
  const subSettled = useRef(false);
  const subManual = useRef(false);   // picked in the menu this play
  const [subOffset, setSubOffset] = useState(0);
  const [subSize, setSubSize] = useState(100);

  useEffect(() => { if (settings) setSubSize(settings.subFontSize); }, [settings]);

  // ---- the list ---- (retry while the torrent is still loading its file list)
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
              const t = bestInLang(r.tracks, want);
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

  // ---- the one in use: fetched, parsed, drawn ----
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
      flash(r.score < 0.35 ? `Weak match, tried ${units(r.offsetMs / 1000, 'second', 1)}` : `Subtitles synced ${offsetLabel(r.offsetMs)}`);
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setSyncBusy(false); }
  };
  const pickSub = (t: SubtitleTrack | null) => {
    setActiveSub(t); subRef.current = t; subSettled.current = true; subManual.current = true;
    if (t) localStorage.setItem(LS_LANG, t.lang); else localStorage.removeItem(LS_LANG);
    saveRef.current();   // remembered for this video right away, not at the next ten-second tick
  };
  const pickSize = (s: number) => { setSubSize(s); api.putSettings({ subFontSize: s }).then((v) => setStore({ settings: v })).catch(() => undefined); };

  // The subtitles key: off, or back on with the track used last.
  const lastSub = useRef<SubtitleTrack | null>(null);
  useEffect(() => { if (activeSub) lastSub.current = activeSub; }, [activeSub]);
  const toggleSubs = () => {
    if (activeSub) { flash('Subtitles off', 'V'); pickSub(null); return; }
    const t = subToTurnOn(subs, lastSub.current);
    if (t) { flash(`Subtitles: ${langName(t.lang || 'und')}`, 'V'); pickSub(t); } else flash('No subtitles available', 'V');
  };

  return { subs, subsLoading, subApplying, activeSub, subRef, subSettled, subOffset, setSubOffset, subSize, pickSize, syncBusy, autoSync, pickSub, toggleSubs };
}
