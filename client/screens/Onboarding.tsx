import { useEffect, useState } from 'react';
import type { Settings } from '../../server/types.js';
import { api, type StateRecovered, type StateRepaired } from '../lib/api';
import { useStore, setStore, toast } from '../lib/store';
import { langName } from '../lib/format';
import { ALWAYS_FIRST, choosableLangs, toggleLang } from '../lib/sub-langs';
import { isIOS, isTouch } from '../lib/player-caps';
import { IconCheck, IconPlus, IconTv, IconSpeaker, IconCast, IconAirplay, IconSearch, IconSubs, IconDownload, IconLayers, IconLock } from '../components/Icons';
import { RecoveredNotice, RepairedNotice } from '../components/RecoveredNotice';
import { Brand } from '../components/Brand';
import '../styles/onboarding.css';

const LANGS = ['eng', 'nor', 'swe', 'dan', 'fin', 'deu', 'fra', 'spa', 'ita', 'nld', 'pol', 'por'];

/**
 * First run. Five short steps: what this is and where to open it, a stream
 * source (Kino ships with none), subtitle languages, the screens it found, and a few tips.
 * Everything here is also in Settings; this just puts it in the right order.
 */
export function Onboarding({ settings, onDone }: { settings: Settings; onDone: (s: Settings) => void }) {
  const [step, setStep] = useState(0);
  const [installed, setInstalled] = useState<string[]>(settings.addons);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [langs, setLangs] = useState<string[]>(settings.subLangs);
  const receivers = useStore((s) => s.receivers);
  const [lanUrl, setLanUrl] = useState(location.origin);
  // A damaged state file was set aside (a fresh state is not set up, so this is where you land) or repaired. Same notices as Settings.
  const [notices, setNotices] = useState<{ recovered?: StateRecovered; repaired?: StateRepaired }>({});
  const noticesDismissed = () => setNotices({});   // one dismiss clears both on the server

  useEffect(() => { api.health().then((h) => { if (h.lanIp) setLanUrl(`http://${h.lanIp}:${location.port || 1234}`); setNotices({ recovered: h.stateRecovered, repaired: h.stateRepaired }); }).catch(() => undefined); }, []);

  // Kino lists no stream addons, so one added here is the one you pasted.
  const hasStream = installed.length > settings.addons.length;

  const add = async (u: string) => {
    setBusy(u);
    try { const r = await api.addAddon(u); setInstalled((l) => [...l.filter((x) => x !== r.url), r.url]); setUrl(''); toast(`Added ${r.name}`); }
    catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(null); }
  };
  const finish = async () => {
    try {
      const s = await api.putSettings({ subLangs: langs, onboarded: true });
      setStore({ settings: s });
      onDone(s);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const tvs = (receivers || []).filter((r) => !r.audioOnly);
  const speakers = (receivers || []).filter((r) => r.audioOnly);

  const steps = [
    {
      title: 'Welcome to Kino',
      body: (
        <>
          <p className="ob-lead">Your own streaming service for the living room. Browse every movie and series, play on the device in your hand, or send it to the TV.</p>
          <div className="ob-url">
            <span>Open this on any phone or laptop on your Wi-Fi</span>
            <strong>{lanUrl}</strong>
            {isIOS ? <small>On iPhone: Share, then "Add to Home Screen" for a full-screen app.</small> : <small>On an iPhone, open it in Safari and use Share, "Add to Home Screen".</small>}
          </div>
        </>
      ),
    },
    {
      title: 'Where streams come from',
      body: (
        <>
          <p className="ob-lead">Kino ships with no stream source of its own. If you use an addon that speaks the Stremio addon protocol, paste its manifest URL here. You can also skip this and play a magnet link.</p>
          <div className="ob-paste">
            <input type="url" placeholder="https://…/manifest.json" value={url} onChange={(e) => setUrl(e.target.value)} autoCorrect="off" autoCapitalize="off" spellCheck={false} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) void add(url.trim()); }} />
            <button className="btn small" disabled={!!busy || !/^https?:\/\/.+manifest\.json/.test(url.trim())} onClick={() => add(url.trim())}><IconPlus /> Add</button>
          </div>
          <p className="ob-note">These are independent third-party services; Kino only asks them for links.</p>
        </>
      ),
    },
    {
      title: 'Subtitles',
      body: (
        <>
          <p className="ob-lead">Which languages should be at the top of every subtitle list? English is always listed first, then the languages you choose here, in the order you tap them.</p>
          <div className="ob-langs">
            <span className="chip big on" aria-disabled="true" style={{ cursor: 'default' }}><IconLock size={14} /> {langName(ALWAYS_FIRST)} <small style={{ fontWeight: 500, opacity: 0.8 }}>Always listed first</small></span>
            {choosableLangs(langs, LANGS).map((c) => {
              const on = langs.includes(c);
              return <button key={c} className={`chip big${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setLangs((l) => toggleLang(l, c))}>{on ? <IconCheck size={14} /> : null} {langName(c)}</button>;
            })}
          </div>
          <p className="ob-note">Subtitles come from OpenSubtitles, from inside the video file, and from the torrent itself. You can nudge their timing while watching.</p>
        </>
      ),
    },
    {
      title: 'Screens and speakers',
      body: (
        <>
          <p className="ob-lead">Kino found these on your network. Cast from any phone or laptop; the TV pulls the video straight from this machine.</p>
          {receivers === null ? <div className="center"><div className="spinner" role="status" aria-label="Loading" /></div> : null}
          {receivers && !receivers.length ? <p className="ob-note">Nothing yet. Chromecasts, Google TVs, Nest speakers and DLNA TVs (LG, Samsung, Sony) show up when they are on. This list updates by itself.</p> : null}
          {tvs.map((r) => <div key={r.id} className="ob-row"><span className="ob-ico"><IconTv /></span><div className="ob-row-text"><strong>{r.name}</strong><span>{r.model}{r.kind === 'dlna' ? ' · DLNA' : ' · Google Cast'}</span></div></div>)}
          {speakers.length ? <div className="ob-row"><span className="ob-ico"><IconSpeaker /></span><div className="ob-row-text"><strong>{speakers.length} speaker{speakers.length === 1 ? '' : 's'}</strong><span>{speakers.map((s) => s.name).join(', ')}</span></div></div> : null}
          {isIOS ? <div className="ob-row"><span className="ob-ico"><IconAirplay /></span><div className="ob-row-text"><strong>AirPlay</strong><span>Apple TVs and AirPlay 2 TVs work from the player's AirPlay button.</span></div></div> : null}
        </>
      ),
    },
    {
      title: 'Good to know',
      body: (
        <>
          <div className="ob-tips">
            <div><IconSearch /><span><strong>Search</strong> finds any movie or series{isTouch ? '' : ', ⌘K from anywhere'}.</span></div>
            <div><IconCast /><span><strong>Cast</strong> controls every TV and speaker, even things you started elsewhere.</span></div>
            <div><IconLayers /><span><strong>Switch source</strong> while watching if a stream stutters{isTouch ? '' : ' (press S)'}.</span></div>
            <div><IconSubs /><span><strong>Subtitles</strong> can be nudged live if they run early or late.</span></div>
            <div><IconDownload /><span><strong>Download for later</strong> for rare titles with few seeders.</span></div>
          </div>
          <p className="ob-note">Everything here lives in Settings too, including this walkthrough.</p>
        </>
      ),
    },
  ];
  const last = step === steps.length - 1;
  const canNext = step !== 1 || hasStream;

  return (
    <div className="ob">
      <div className="ob-card">
        {notices.recovered ? <RecoveredNotice recovered={notices.recovered} onDismissed={noticesDismissed} why={settings.onboarded === false ? 'That is why this walkthrough is showing again.' : undefined} /> : null}
        {notices.repaired ? <RepairedNotice repaired={notices.repaired} onDismissed={noticesDismissed} /> : null}
        <div className="ob-progress">{steps.map((_, i) => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
        <div className="ob-brand"><Brand /></div>
        <h1>{steps[step].title}</h1>
        <div className="ob-body">{steps[step].body}</div>
        <div className="ob-actions">
          {step > 0 ? <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button> : <span />}
          <span className="ob-spacer" />
          {step === 1 && !hasStream ? <button className="btn ghost" onClick={() => setStep(step + 1)}>Skip for now</button> : null}
          {last ? <button className="btn primary" onClick={finish}>Start watching</button> : <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</button>}
        </div>
      </div>
    </div>
  );
}
