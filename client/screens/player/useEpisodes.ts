import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Episode, Meta, PlayResponse, Progress } from '../../../server/types.js';
import { api } from '../../lib/api';
import { navigate, playUrl, titleUrl, type PlayParams } from '../../lib/router';
import { target } from '../../lib/player-caps';
import { toast } from '../../lib/store';
import { noEpisodeSourceWords } from '../../lib/playback';
import { nextSource } from '../../../server/next-source.js';
import { sortedEpisodes } from '../../components/EpisodePicker';

interface EpisodesArgs {
  p: PlayParams;
  attempt: number;
  play: PlayResponse | null;
  totalDur: () => number;
  absTime: () => number;
  saveRef: RefObject<(beacon?: boolean) => void>;
}

/**
 * A series around the episode playing: the show (for the shelf and the title), the next episode, when to offer it
 * (at the credits, estimated server-side, instead of a flat 30 s before the end) and moving on to it.
 */
export function useEpisodes(a: EpisodesArgs) {
  const { p, attempt, play, totalDur, absTime, saveRef } = a;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [epProgress, setEpProgress] = useState<Record<string, Progress>>({});
  const [epsOpen, setEpsOpen] = useState(false);
  const [next, setNext] = useState<Episode | null>(null);
  const [showNext, setShowNext] = useState(false);
  const nextShown = useRef(false);
  const [ended, setEnded] = useState(false);
  // Where the credits start, estimated server-side; the popup fires there instead of a flat 30 s before the end.
  const [credits, setCredits] = useState<{ at?: number; source: string; confidence: string } | null>(null);
  const creditsRef = useRef<{ at?: number; confidence: string } | null>(null);
  useEffect(() => { creditsRef.current = credits; }, [credits]);
  // Moved on to the next episode (at the credits, usually): from then on this one is saved as watched to the end.
  const movedOn = useRef(false);

  // Every start of a play (a new file, or a retry) offers the next episode afresh.
  useEffect(() => {
    nextShown.current = false; setShowNext(false); setEnded(false);
  }, [p.infoHash, p.fileIdx, p.videoId, attempt]);

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
      const src = nextSource(r.sources, r.auto, { infoHash: p.infoHash, bingeGroup: sessionStorage.getItem('kino.binge') });
      if (!src) { toast(noEpisodeSourceWords(r.sources.length > 0, opts.next), 'error'); navigate(titleUrl('series', p.metaId, ep.id)); return; }
      if (opts.next) movedOn.current = true;
      saveRef.current();
      navigate(playUrl({ type: 'series', videoId: ep.id, metaId: p.metaId, infoHash: src.infoHash, fileIdx: src.fileIdx, name: `${meta.name} S${ep.season} E${ep.episode} ${ep.title || ''}`.trim(), poster: meta.poster, background: ep.thumbnail || meta.background, season: ep.season, episode: ep.episode, t: opts.next ? 0 : undefined }), true);
    } catch (e) { toast((e as Error).message, 'error'); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, p.metaId, p.infoHash, p.magnet, totalDur, absTime]);
  const playNext = useCallback(async (manual = true) => { if (next) await playEpisode(next, { next: true, manual }); }, [next, playEpisode]);
  // Ask for the credits estimate once playback runs and there is a next episode to go to.
  useEffect(() => {
    if (!next || !play || p.magnet) return;
    let dead = false;
    api.credits({ infoHash: p.infoHash, fileIdx: play.fileIdx, videoId: p.videoId, metaId: p.metaId }).then((c) => { if (!dead) setCredits(c); }).catch(() => undefined);
    return () => { dead = true; };
  }, [next, play, p.infoHash, p.videoId, p.metaId, p.magnet]);

  return { meta, epProgress, epsOpen, setEpsOpen, next, showNext, setShowNext, nextShown, ended, setEnded, credits, creditsRef, movedOn, playEpisode, playNext };
}
