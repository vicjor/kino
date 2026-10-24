import { useEffect, useState } from 'react';
import type { TorrentFileInfo, Progress } from '../../server/types.js';
import { api } from '../lib/api';
import { navigate, playUrl } from '../lib/router';
import { toast } from '../lib/store';
import { sendToTv, useSingleTv, type Tv } from '../lib/cast-actions';
import { fmtBytes, relTime, episodeTag } from '../lib/format';
import { resumePoint } from '../lib/progress';
import { TopBar } from '../components/TopBar';
import { CastPicker } from '../components/CastPicker';
import { IconPlay, IconCast, IconMagnet, IconLink } from '../components/Icons';
import '../styles/title.css';
import '../styles/magnet.css';

const looksLikeMagnet = (s: string) => /^magnet:\?/i.test(s.trim()) || /^[a-f0-9]{40}$/i.test(s.trim()) || /^[a-z2-7]{32}$/i.test(s.trim());

export function Magnet() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tor, setTor] = useState<{ infoHash: string; name: string; files: TorrentFileInfo[] } | null>(null);
  const [castFile, setCastFile] = useState<TorrentFileInfo | null>(null);
  const [castingIdx, setCastingIdx] = useState<number | null>(null);
  const [recent, setRecent] = useState<Progress[]>([]);
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

  useEffect(() => { api.history().then((h) => setRecent(h.filter((p) => p.metaId.startsWith('magnet:')).slice(0, 8))).catch(() => undefined); }, []);

  const add = async (value = input) => {
    const v = value.trim();
    if (!v) return;
    setBusy(true); setTor(null);
    try { setTor(await api.torrentAdd(v)); } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(false); }
  };
  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!looksLikeMagnet(t)) { toast('The clipboard has no magnet link or info hash'); return; }
      setInput(t); void add(t);
    } catch { toast('Could not read the clipboard', 'error'); }
  };
  const videoId = (f: TorrentFileInfo) => `magnet:${tor?.infoHash}:${f.index}`;
  const play = (f: TorrentFileInfo) => {
    if (!tor) return;
    navigate(playUrl({ type: 'movie', videoId: videoId(f), metaId: `magnet:${tor.infoHash}`, infoHash: tor.infoHash, fileIdx: f.index, name: f.name, magnet: true }));
  };
  const castTo = async (d: Tv, f: TorrentFileInfo) => {
    if (!tor) return;
    setCastingIdx(f.index);
    if (await sendToTv(d, (deviceId) => api.castPlay({ deviceId, infoHash: tor.infoHash, fileIdx: f.index, videoId: videoId(f), title: f.name }), `Casting to ${d.name}`)) setCastFile(null);
    setCastingIdx(null);
  };
  // Like "On TV" on a title: a single TV online gets the file straight away, otherwise the picker opens.
  const onlyTv = useSingleTv();
  const castLabel = onlyTv ? `Play on ${onlyTv.name}` : 'Cast to a device';
  const cast = (f: TorrentFileInfo) => { if (castingIdx != null) return; if (onlyTv) void castTo(onlyTv, f); else setCastFile(f); };
  const videos = tor ? tor.files.filter((f) => f.isVideo) : [];
  const others = tor ? tor.files.filter((f) => !f.isVideo) : [];
  // A season pack's file names often differ only past the point where they are cut off: label each episode.
  const pack = videos.length > 1;
  return (
    <div className="screen magnet">
      <TopBar backTo="/" title="Magnet link" right={null} />
      <div className="magnet-body">
        <div className={`magnet-box${busy ? ' busy' : ''}`}>
          <div className="magnet-ico"><IconMagnet size={28} /></div>
          <textarea rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder="magnet:?xt=urn:btih:…  or a 40-character info hash" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void add(); } }} />
          <div className="magnet-actions">
            {canPaste ? <button className="btn ghost" onClick={paste} disabled={busy}><IconLink /> Paste</button> : null}
            <button className="btn primary" disabled={busy || !input.trim()} onClick={() => add()}>{busy ? <><span className="spinner sm" /> Fetching</> : 'Load torrent'}</button>
          </div>
        </div>
        <p className="magnet-hint">Only the file you pick is downloaded, into the 10 GB cache. Progress is remembered like any other title.</p>
        {tor ? (
          <section className="magnet-files">
            <h2>{tor.name}</h2>
            <p className="hint">{videos.length} video{videos.length === 1 ? '' : 's'}{others.length ? `, ${others.length} other file${others.length === 1 ? '' : 's'}` : ''}. Tap one to play.</p>
            <ul className="sources">
              {videos.map((f) => {
                const ep = pack ? episodeTag(f.name) : '';
                return (
                  <li key={f.index} className="source" role="button" tabIndex={0} onClick={() => play(f)} onKeyDown={(e) => { if (e.key === 'Enter') play(f); }}>
                    <span className="src-play" aria-hidden="true"><IconPlay /></span>
                    <div className="src-main">
                      <div className="src-line1">
                        {ep ? <span className="chip strong magnet-ep">{ep}</span> : null}
                        <span className="src-provider magnet-name">{f.name}</span>
                        <span className="src-size-inline"><b>{fmtBytes(f.length)}</b></span>
                      </div>
                      <div className="src-name">{f.path}</div>
                    </div>
                    <div className="src-size"><b>{fmtBytes(f.length)}</b></div>
                    <div className="src-actions"><button className="iconbtn" aria-label={castLabel} title={castLabel} disabled={castingIdx != null} onClick={(e) => { e.stopPropagation(); cast(f); }}>{castingIdx === f.index ? <span className="spinner tiny" /> : <IconCast />}</button></div>
                  </li>
                );
              })}
            </ul>
            {others.length ? <details className="magnet-others"><summary>{others.length} other file{others.length === 1 ? '' : 's'}</summary><ul>{others.map((f) => <li key={f.index}><span className="magnet-other-name">{f.name}</span><span className="magnet-other-size">{fmtBytes(f.length)}</span></li>)}</ul></details> : null}
          </section>
        ) : null}
        {!tor && recent.length ? (
          <section className="magnet-recent">
            <h2>Recent</h2>
            <ul>
              {recent.map((p) => (
                <li key={p.videoId}>
                  <button className="magnet-row" onClick={() => p.infoHash != null && p.fileIdx != null ? navigate(playUrl({ type: 'movie', videoId: p.videoId, metaId: p.metaId, infoHash: p.infoHash, fileIdx: p.fileIdx, name: p.name, magnet: true, t: resumePoint(p) ?? 0 })) : undefined}>
                    <span className="src-play" aria-hidden="true"><IconPlay /></span>
                    <span className="magnet-row-text"><span className="magnet-name">{p.name}</span><small>{relTime(p.updatedAt)}{p.dur ? ` · ${Math.round((p.pos / p.dur) * 100)}%` : ''}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {castFile ? <CastPicker onPick={(d) => void castTo(d, castFile)} onClose={() => setCastFile(null)} busy={castingIdx != null} /> : null}
    </div>
  );
}
