import { useEffect, useState } from 'react';
import type { Settings as S } from '../../server/types.js';
import { api, type StateRecovered, type StateRepaired } from '../lib/api';
import { navigate } from '../lib/router';
import { FIELDS, fieldChange, type FieldKey } from '../lib/settings-fields';
import { setStore, toast } from '../lib/store';
import { useLoad } from '../lib/use-load';
import { fmtBytes, relTime, langName } from '../lib/format';
import { scrollBehavior } from '../lib/motion';
import { storageBar } from '../lib/storage';
import { streamSource, downCallout } from '../lib/addon-status';
import { TopBar } from '../components/TopBar';
import { IconTrash, IconPlus, IconX } from '../components/Icons';
import { openCastCenter } from '../lib/overlays';
import { AddonCatalog } from '../components/AddonCatalog';
import { RecoveredNotice, RepairedNotice } from '../components/RecoveredNotice';
import '../styles/settings.css';

const LANG_PRESETS = ['eng', 'nor', 'swe', 'dan', 'fin', 'deu', 'fra', 'spa'];

/** /health says ffprobe or ffmpeg cannot run here (missing, or built for another CPU): what breaks and how to fix it. */
function binWarning(h: Record<string, unknown> | null): { title: string; text: string; fix: string; cmd?: string } | null {
  const broken = h ? (['ffprobe', 'ffmpeg'] as const).filter((b) => h[b] === false) : [];
  if (!h || !broken.length) return null;
  const mac = h.platform === 'darwin';
  const probe = broken.includes('ffprobe');
  return {
    title: probe ? 'Videos will not start' : 'Some videos will not play',
    text: `Kino cannot run ${broken.join(' or ')} on ${mac ? 'this Mac' : 'this computer'}, so ${probe ? 'videos will not start' : 'videos that need converting will not play'}.`,
    // Homebrew's ffmpeg formula brings ffprobe too; the server picks /opt/homebrew/bin when the bundled one does not run.
    ...(mac ? { fix: `Install ${broken.length > 1 ? 'them' : 'it'} with Homebrew:`, cmd: 'brew install ffmpeg' } : { fix: 'Install ffmpeg with the package manager of this computer' }),
  };
}

/** An addon row's line while Kino skips it for not answering. The skip lasts a minute, so seconds are enough. */
function skippedText(failedAt: number, now = Date.now()): string {
  const s = Math.max(1, Math.round((now - failedAt) / 1000));
  return `Skipped, did not answer ${s} second${s === 1 ? '' : 's'} ago`;
}

/** The downloads in Library: Library scrolls to them when it opens with show=downloads. */
const LIBRARY_DOWNLOADS = '#/library?show=downloads';
const NAV = [{ id: 's-sources', label: 'Sources' }, { id: 's-subtitles', label: 'Subtitles' }, { id: 's-playback', label: 'Playback' }, { id: 's-storage', label: 'Storage' }, { id: 's-cast', label: 'Cast' }, { id: 's-ratings', label: 'Ratings' }, { id: 's-home-assistant', label: 'Home Assistant' }, { id: 's-backup', label: 'Backup' }, { id: 's-about', label: 'About' }];

export function Settings() {
  // Loaded once, not again on coming back into view: a reload landing during a save could put the old values back.
  const settingsLoad = useLoad(() => api.settings().then((v) => { setStore({ settings: v }); return v; }), { visible: false });
  const { data: s, setData: setS, error: err } = settingsLoad;
  // null until the list loads: an empty list says "nothing installed", a failed load says so instead.
  const addonsLoad = useLoad(api.addons, { visible: false });
  const { data: addons, setData: setAddons, error: addonsErr } = addonsLoad;
  const diskLoad = useLoad(api.disk, { visible: false });
  const { data: disk, setData: setDisk } = diskLoad;
  const healthLoad = useLoad(() => api.health().then((h) => h as unknown as Record<string, unknown>), { visible: false });
  const { data: health, setData: setHealth } = healthLoad;
  const [newAddon, setNewAddon] = useState('');
  const [newLang, setNewLang] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState(false);

  const retry = () => { settingsLoad.retry(); addonsLoad.retry(); diskLoad.retry(); healthLoad.retry(); };
  // While an addon is skipped or down, ask again now and then: the row counts up, and turns healthy once it answers.
  useEffect(() => {
    const wait = addons?.some((a) => a.skipped) ? 10_000 : addons?.some((a) => !a.ok) ? 30_000 : 0;
    if (!wait) return;
    const t = setTimeout(() => api.addons().then(setAddons).catch(() => undefined), wait);
    return () => clearTimeout(t);
  }, [addons]);

  /**
   * Shows the change at once. A refusal shows the server's own words, and the screen goes back to what the server
   * holds (the last saved values when it cannot be reached). Returns the settings as they stand after the save.
   */
  const save = async (patch: Partial<S>): Promise<S | undefined> => {
    if (!s) return;
    setS({ ...s, ...patch });
    try { const v = await api.putSettings(patch); setS(v); setStore({ settings: v }); return v; }
    catch (e) {
      toast((e as Error).message, 'error', 6000);
      const v = await api.settings().catch(() => s);
      setS(v); setStore({ settings: v }); return v;
    }
  };
  /** A field saves when you leave it, only when it says something other than what is saved, then shows what was kept. */
  const saveField = async (k: FieldKey, el: HTMLInputElement) => {
    if (!s) return;
    const t = FIELDS[k], patch = fieldChange(k, el.value, s);
    if (!patch) { el.value = t.show(s); return; }
    const v = await save(patch);
    if (v && document.activeElement !== el) el.value = t.show(v);   // never under your fingers if you went back to typing
  };
  const addAddon = async () => {
    const url = newAddon.trim();
    if (!url) return;
    setBusy(true);
    try { const a = await api.addAddon(url); if (addons) setAddons((l) => [...(l || []).filter((x) => x.url !== a.url), a]); else addonsLoad.reload(); setNewAddon(''); toast(a.ok ? `Added ${a.name}` : `Added, but: ${a.error}`); }
    catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(false); }
  };
  const removeAddon = async (url: string) => {
    try { await api.removeAddon(url); setAddons((l) => l && l.filter((x) => x.url !== url)); } catch (e) { toast((e as Error).message, 'error'); }
  };
  // One row that is saved for later goes from the downloads too (the server drops it with its files), so ask first.
  const clear = async (infoHash?: string) => {
    const saved = !!infoHash && !!disk?.entries.some((e) => e.infoHash === infoHash && e.download);
    if (!infoHash && !confirm(`Delete all cached data?${disk?.entries.some((e) => e.download) ? ' Downloads you saved for later are kept.' : ''}`)) return;
    if (saved && !confirm('This is saved for later. Delete it anyway?')) return;
    setBusy(true);
    try {
      setDisk(await api.clearCache(infoHash));
      toast(saved ? 'Deleted, and taken off your downloads' : infoHash ? 'Removed' : 'Cache cleared');
      if (saved) api.downloads().then((d) => setStore({ downloads: d })).catch(() => undefined);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const addLang = (code: string) => {
    const c = code.trim().toLowerCase();
    if (!s || !c || s.subLangs.includes(c)) return;
    save({ subLangs: [...s.subLangs, c] });
    setNewLang('');
  };

  if (!s) return <div><TopBar backTo="/" title="Settings" right={null} />{err ? <div className="err" role="alert">{err} <button className="btn small" onClick={retry}>Try again</button></div> : <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div>}</div>;
  const bins = binWarning(health);
  const source = addons && streamSource(addons);
  const down = source?.kind === 'down' ? downCallout(source) : null;
  const bar = disk && storageBar(disk);
  // Downloads alone are past the cache limit: only deleting some frees room, so the line leads to them in Library.
  const savedOver = !!disk && Math.min(disk.cacheBytes, disk.downloadBytes ?? 0) > disk.cacheCapBytes;   // as storageBar counts them
  const recovered = health?.stateRecovered as StateRecovered | undefined;
  const repaired = health?.stateRepaired as StateRepaired | undefined;
  const noticesDismissed = () => setHealth((h) => h && { ...h, stateRecovered: undefined, stateRepaired: undefined });   // one dismiss clears both on the server
  /** A number field shows what is saved and saves once, when you leave it or press Enter: never per keystroke. */
  const numField = (k: 'autoNextDelaySec' | 'cacheCapBytes' | 'minFreeBytes') => ({
    defaultValue: FIELDS[k].show(s),
    onBlur: (e: { currentTarget: HTMLInputElement }) => void saveField(k, e.currentTarget),
    onKeyDown: (e: { key: string; currentTarget: HTMLInputElement }) => { if (e.key === 'Enter') e.currentTarget.blur(); },
  });
  return (
    <div className="settings">
      <TopBar backTo="/" title="Settings" right={null} />
      <nav className="settings-nav" aria-label="Settings sections">
        {NAV.map((n) => <a key={n.id} href={`#/settings#${n.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(n.id)?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); }}>{n.label}</a>)}
      </nav>
      <div className="settings-body">
        {recovered ? <RecoveredNotice recovered={recovered} onDismissed={noticesDismissed} /> : null}
        {repaired ? <RepairedNotice repaired={repaired} onDismissed={noticesDismissed} /> : null}
        {health?.pinPaused === true ? (
          // 150 wrong PINs or more from everyone together: someone keeps guessing (server/pin.ts LONG_PAUSE_MS).
          <div className="callout" role="alert">
            <strong>Many wrong PIN tries</strong>
            <p>Kino is pausing PIN attempts. Consider a longer PIN.</p>
          </div>
        ) : null}
        {bins ? (
          <div className="callout" role="alert">
            <strong>{bins.title}</strong>
            <p>{bins.text} {bins.fix}{bins.cmd ? <> <code>{bins.cmd}</code></> : null}, then restart Kino.</p>
          </div>
        ) : null}
        <section id="s-sources">
          <h2>Sources</h2>
          <p className="hint">Where streams and subtitles come from. Kino speaks the Stremio addon protocol. OpenSubtitles is included; paste the manifest URL of a stream addon you use to get sources.</p>
          {down ? (
            <div className="callout">
              <strong>{down.title}</strong>
              <p>{down.text}</p>
            </div>
          ) : source?.kind === 'none' ? (
            <div className="callout">
              <strong>No stream source yet</strong>
              <p>Kino finds sources through a <em>stream</em> addon, and none is installed, so every title will show "No sources found". Paste the manifest URL of a stream addon you use below (it ends in <code>manifest.json</code>).</p>
            </div>
          ) : null}
          <button className="btn primary small" onClick={() => setCatalog(true)}><IconPlus /> Subtitle addons</button>
          {!addons && addonsErr ? <div className="err" role="alert">Your addons did not load. {addonsErr} <button className="btn small" onClick={addonsLoad.retry}>Try again</button></div> : null}
          <ul className="list">
            {(addons || []).map((a) => (
              <li key={a.url} className="row">
                <span className="grow">{a.name || 'Addon'}<small>{!a.ok ? a.error || 'Unreachable' : a.skipped ? skippedText(a.skipped.failedAt) : `${a.types.join(', ')} · ${a.resources.join(', ')}`}</small></span>
                {!a.ok ? <span className="chip warn">Error</span> : a.skipped ? <span className="chip warn">Skipped</span> : <span className="chip ok">OK</span>}
                <button className="iconbtn" aria-label="Remove" onClick={() => removeAddon(a.url)}><IconTrash /></button>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ marginTop: 12 }}>Have a manifest URL from somewhere else? Paste it here.</p>
          <div className="addrow">
            <input type="url" placeholder="https://…/manifest.json" value={newAddon} onChange={(e) => setNewAddon(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addAddon(); }} />
            <button className="btn small" disabled={busy || !newAddon.trim()} onClick={addAddon}><IconPlus /> Add</button>
          </div>
        </section>

        <section id="s-subtitles">
          <h2>Subtitles</h2>
          <p className="hint">Languages in the order you prefer them.</p>
          <div className="langs">
            {s.subLangs.map((c) => (
              <span key={c} className="chip strong lang">{langName(c)} <button aria-label={`Remove ${langName(c)}`} onClick={() => save({ subLangs: s.subLangs.filter((x) => x !== c) })}><IconX size={14} /></button></span>
            ))}
          </div>
          <div className="langs presets">
            {LANG_PRESETS.filter((c) => !s.subLangs.includes(c)).map((c) => <button key={c} className="chip" onClick={() => addLang(c)}>+ {langName(c)}</button>)}
          </div>
          <div className="addrow">
            <input type="text" placeholder="ISO 639-2 code, e.g. ita" value={newLang} maxLength={3} onChange={(e) => setNewLang(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addLang(newLang); }} />
            <button className="btn small" disabled={newLang.trim().length !== 3} onClick={() => addLang(newLang)}><IconPlus /> Add</button>
          </div>
          <div className="field">
            <label>Subtitle size: {s.subFontSize}%</label>
            <input type="range" min={70} max={180} step={10} value={s.subFontSize} onChange={(e) => setS({ ...s, subFontSize: Number(e.target.value) })} onPointerUp={() => save({ subFontSize: s.subFontSize })} onKeyUp={() => save({ subFontSize: s.subFontSize })} />
          </div>
        </section>

        <section id="s-playback">
          <h2>Playback</h2>
          <label className="switch"><span>Turn subtitles on automatically (first language above)</span><input type="checkbox" checked={s.autoSubs ?? true} onChange={(e) => save({ autoSubs: e.target.checked })} /></label>
          <label className="switch"><span>Play next episode automatically</span><input type="checkbox" checked={s.autoNext} onChange={(e) => save({ autoNext: e.target.checked })} /></label>
          <div className="field"><label>Countdown before next episode (seconds)</label><input type="number" min={3} max={60} {...numField('autoNextDelaySec')} /></div>
        </section>

        <section id="s-storage">
          <h2>Storage</h2>
          {disk && bar ? (
            <>
              <div className="diskbar" title={`${fmtBytes(disk.cacheBytes) || '0 MB'} cached`}>
                {bar.saved ? <i className="saved" style={{ width: `${bar.saved}%` }} /> : null}
                <i style={{ width: `${bar.cached}%` }} />
              </div>
              <p className="hint">
                {bar.used} · {fmtBytes(disk.freeBytes)} free on disk{disk.hlsBytes ? ` · ${fmtBytes(disk.hlsBytes)} transcode temp` : ''}
                {bar.savedLine ? savedOver
                  ? <a className="disk-saved" href={LIBRARY_DOWNLOADS}><i aria-hidden="true" /><span style={{ textDecoration: 'underline' }}>{bar.savedLine}</span></a>
                  : <span className="disk-saved"><i aria-hidden="true" />{bar.savedLine}</span> : null}
              </p>
              <ul className="list">
                {disk.entries.map((e) => (
                  <li key={e.infoHash} className="row">
                    <span className="grow">{e.name}<small>{fmtBytes(e.bytes)} · {relTime(e.lastUsed)}{e.active ? ' · playing' : ''}{e.download ? ' · saved for later' : ''}</small></span>
                    <button className="iconbtn" aria-label="Delete" disabled={busy || e.active} onClick={() => clear(e.infoHash)}><IconTrash /></button>
                  </li>
                ))}
              </ul>
              {disk.entries.some((e) => !e.active && !e.download) ? <button className="btn small danger ghost" disabled={busy} onClick={() => clear()}>Clear all cached data</button> : null}
            </>
          ) : null}
          <div className="two">
            <div className="field"><label>Cache limit (GB)</label><input type="number" min={1} max={200} {...numField('cacheCapBytes')} /></div>
            <div className="field"><label>Keep free on disk (GB)</label><input type="number" min={1} max={100} {...numField('minFreeBytes')} /></div>
          </div>
        </section>

        <section id="s-cast">
          <h2>Cast</h2>
          <p className="hint">Control every Chromecast, TV and speaker on this network, whoever started it. <code>/api/cast/stop-all</code> stops everything at once, for Home Assistant or a shortcut.</p>
          <button className="btn ghost" onClick={openCastCenter}>Open Cast controls</button>
        </section>

        <section id="s-ratings">
          <h2>Ratings</h2>
          <p className="hint">IMDb ratings, including per episode, come straight from IMDb's public dataset (downloaded once a week, no account). Rotten Tomatoes and Metacritic need a free OMDb key from omdbapi.com.</p>
          <div className="field"><label>TMDB API key (optional)</label><input type="text" placeholder="for trending, recommendations and hidden gems on Home" defaultValue={FIELDS.tmdbApiKey.show(s)} autoCorrect="off" autoCapitalize="off" spellCheck={false} onBlur={(e) => saveField('tmdbApiKey', e.currentTarget)} /></div>
          <div className="field"><label>OMDb API key (optional)</label><input type="text" placeholder="e.g. a1b2c3d4" defaultValue={FIELDS.omdbApiKey.show(s)} autoCorrect="off" autoCapitalize="off" spellCheck={false} onBlur={(e) => saveField('omdbApiKey', e.currentTarget)} /></div>
        </section>

        <section id="s-home-assistant">
          <h2>Home Assistant</h2>
          <p className="hint">Optional. Kino sends play, pause and stop events to this webhook when casting, so an automation can dim the lights.</p>
          <div className="field"><label>Webhook URL</label><input type="url" placeholder="http://homeassistant.local:8123/api/webhook/kino" defaultValue={FIELDS.haWebhookUrl.show(s)} onBlur={(e) => saveField('haWebhookUrl', e.currentTarget)} /></div>
        </section>

        <section id="s-backup">
          <h2>Backup</h2>
          <p className="hint">Everything Kino remembers (progress, watchlist, follows, settings, downloads) is one file. Download it, or restore one from another machine; restoring merges, it never deletes.</p>
          <div className="addrow" style={{ alignItems: 'center' }}>
            <a className="btn small" href="/api/backup" download>Download backup</a>
            <label className="btn small ghost" style={{ cursor: 'pointer' }}>Restore from file<input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              try { const r = await api.restore(JSON.parse(await f.text())); toast(`Restored: ${r.progress} titles in progress, ${r.watchlist} in watchlist`, 'info', 6000); }
              catch (err) { toast((err as Error).message, 'error', 6000); }
              e.target.value = '';
            }} /></label>
          </div>
        </section>

        <section id="s-about">
          <h2>About</h2>
          {health ? (
            <ul className="list about">
              <li className="row"><span className="grow">Kino {String(health.version || '')}<small>Node {String(health.node || '')} on {String(health.platform || '')}, up {Math.round(Number(health.uptime || 0) / 3600)} h</small></span></li>
              <li className="row"><span className="grow">Reachable at http://{String(health.lanIp || location.hostname)}:{location.port || 1234}<small>open this on phones and laptops on the same Wi-Fi</small></span></li>
              <li className="row"><span className="grow">Transcoder<small>{health.ffmpeg ? `ffmpeg present, ${health.hwEncoder ? 'hardware (VideoToolbox) encode' : 'software encode'}` : 'ffmpeg does not run: only direct play works'}</small></span>{health.ffmpeg ? <span className="chip ok">OK</span> : <span className="chip warn">Not working</span>}</li>
              <li className="row"><span className="grow">IMDb ratings data<small>{health.imdbDatasets == null ? 'not downloaded yet' : `updated ${health.imdbDatasets} day${health.imdbDatasets === 1 ? '' : 's'} ago, refreshes weekly`}</small></span></li>
              <li className="row"><span className="grow">TVs and speakers found<small>{String(health.castDevices ?? 0)} on the network</small></span></li>
              <li className="row"><span className="grow">Data folder<small>{String(health.dataDir || '')}</small></span></li>
            </ul>
          ) : null}
          <p className="hint">Add Kino to your home screen for full-screen playback on iPhone.</p>
          <button className="btn ghost small" onClick={() => navigate('/welcome')}>Show the first-run walkthrough again</button>
        </section>
      </div>
      {catalog ? <AddonCatalog onClose={() => setCatalog(false)} onChange={setAddons} /> : null}
    </div>
  );
}
