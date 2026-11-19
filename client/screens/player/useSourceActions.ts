import { useState } from 'react';
import type { PickOutcome, Source } from '../../../server/types.js';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { navigate, playUrl, type PlayParams } from '../../lib/router';
import { target } from '../../lib/player-caps';
import { switchWords } from '../../lib/playback';

/**
 * The ways out of a source that does not play well: another release from where you are (picked, or the best other
 * one), or downloading it to watch later. `stallBusy` covers the two the stall sheet offers.
 */
export function useSourceActions(p: PlayParams, absTime: () => number, outcome: (kind: PickOutcome) => void, leave: () => void) {
  const [stallBusy, setStallBusy] = useState(false);
  const currentSourceId = `${p.infoHash}:${p.fileIdx ?? -1}`;
  const goTo = (alt: Source) => navigate(playUrl({ type: p.type, videoId: p.videoId, metaId: p.metaId, infoHash: alt.infoHash, fileIdx: alt.fileIdx, name: p.name, poster: p.poster, background: p.background, season: p.season, episode: p.episode, t: Math.max(0, absTime()) }), true);
  const switchSource = async () => {
    setStallBusy(true);
    try {
      const r = await api.streams(p.type, p.videoId, target());
      const alt = r.sources.find((s) => s.id !== currentSourceId && s.score > 0) || r.sources.find((s) => s.id !== currentSourceId);
      if (!alt) { toast('No other sources for this one', 'error'); leave(); return; }
      outcome('switch');
      toast(`Switching to ${alt.provider || alt.addon} ${alt.resolution && alt.resolution !== 'other' ? alt.resolution : ''}`.trim());
      goTo(alt);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setStallBusy(false); }
  };
  const switchTo = (alt: Source) => {
    outcome('switch');
    toast(switchWords(alt));
    goTo(alt);
  };
  const downloadSource = async (s: Source) => {
    try {
      await api.addDownload({ infoHash: s.infoHash, fileIdx: s.fileIdx, videoId: p.videoId, metaId: p.metaId, type: p.type as 'movie' | 'series', name: p.name, poster: p.poster, background: p.background });
      toast('Downloading for later. It shows up on Home when ready.', 'info', 5000);
    } catch (e) { toast((e as Error).message, 'error', 6000); }
  };
  const downloadLater = async () => {
    setStallBusy(true);
    try {
      await api.addDownload({ infoHash: p.infoHash, fileIdx: p.fileIdx, videoId: p.magnet ? undefined : p.videoId, metaId: p.magnet ? undefined : p.metaId, type: p.type as 'movie' | 'series', name: p.name, poster: p.poster, background: p.background });
      toast('Downloading in the background. It shows up on Home when ready.', 'info', 5000);
      leave();
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setStallBusy(false); }
  };
  return { currentSourceId, stallBusy, switchSource, switchTo, downloadSource, downloadLater };
}
