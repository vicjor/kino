import { execFile } from 'node:child_process';
import type { Torrent } from 'webtorrent';
import { fetchText } from '../http.js';
import { logger, errMsg } from '../log.js';
import { httpError } from '../errors.js';
import { getState } from '../store.js';
import { getAddonSubtitles } from '../addons.js';
import { probeCached } from '../media/probe.js';
import { binPath, isSpawnError, startFailure } from '../media/bins.js';
import { killOnShutdown } from '../lifecycle.js';
import { openFile, closeFile } from '../torrent.js';
import { localFileUrl } from '../media/range.js';
import { convert, decodeSubtitle } from './srt2vtt.js';
import { oshash } from './oshash.js';
import { encodeSubId as enc, decodeSubId } from './ids.js';
import { cachePath, readCached, writeCached, maybePrune } from './cache.js';
import type { MediaType, SubtitleTrack } from '../types.js';

const log = logger('subs');

const LANG_NAMES: Record<string, string> = {
  eng: 'English', nor: 'Norsk', nob: 'Norsk bokmål', nno: 'Nynorsk', swe: 'Svenska', dan: 'Dansk', fin: 'Suomi', deu: 'Deutsch', ger: 'Deutsch', fra: 'Français', fre: 'Français',
  spa: 'Español', ita: 'Italiano', por: 'Português', pob: 'Português (BR)', nld: 'Nederlands', dut: 'Nederlands', pol: 'Polski', rus: 'Русский', jpn: '日本語', kor: '한국어', zho: '中文', chi: '中文',
  ara: 'العربية', tur: 'Türkçe', gre: 'Ελληνικά', ces: 'Čeština', cze: 'Čeština', hun: 'Magyar', ron: 'Română', rum: 'Română', sqi: 'Shqip', alb: 'Shqip', ben: 'বাংলা', bos: 'Bosanski', bul: 'Български', hrv: 'Hrvatski', srp: 'Srpski', slv: 'Slovenščina', slk: 'Slovenčina', slo: 'Slovenčina', est: 'Eesti', lav: 'Latviešu', lit: 'Lietuvių', isl: 'Íslenska', ice: 'Íslenska', cat: 'Català', glg: 'Galego', eus: 'Euskara', baq: 'Euskara', mkd: 'Македонски', mac: 'Македонски', msa: 'Melayu', may: 'Melayu', fil: 'Filipino', tgl: 'Tagalog', tam: 'தமிழ்', tel: 'తెలుగు', mal: 'മലയാളം', hin: 'हिन्दी', urd: 'اردو', fas: 'فارسی', per: 'فارسی', kur: 'Kurdî', aze: 'Azərbaycan', kaz: 'Қазақша', kat: 'ქართული', geo: 'ქართული', hye: 'Հայերեն', arm: 'Հայերեն', mon: 'Монгол', khm: 'ខ្មែរ', mya: 'မြန်မာ', bur: 'မြန်မာ', sin: 'සිංහල', nep: 'नेपाली', swa: 'Kiswahili', afr: 'Afrikaans', bel: 'Беларуская', mri: 'Māori', lat: 'Latina', epo: 'Esperanto', mlt: 'Malti', gle: 'Gaeilge', cym: 'Cymraeg', wel: 'Cymraeg', bre: 'Brezhoneg', oci: 'Occitan', ltz: 'Lëtzebuergesch', pan: 'ਪੰਜਾਬੀ', guj: 'ગુજરાતી', kan: 'ಕನ್ನಡ', mar: 'मराठी', ori: 'ଓଡ଼ିଆ', asm: 'অসমীয়া', som: 'Soomaali', amh: 'አማርኛ', tir: 'ትግርኛ', uzb: 'Oʻzbek', kir: 'Кыргызча', tgk: 'Тоҷикӣ', tuk: 'Türkmen', lao: 'ລາວ', pus: 'پښتو', snd: 'سنڌي', syr: 'Syriac', tat: 'Татарча', abk: 'Abkhaz', ast: 'Asturianu', ext: 'Estremeñu', zht: '中文 (繁體)', zhe: '中文/English', spl: 'Español (LA)', spn: 'Español (ES)', pom: 'Português (MZ)', ell: 'Ελληνικά', scc: 'Srpski', tha: 'ไทย', vie: 'Tiếng Việt', ind: 'Indonesia', ukr: 'Українська', heb: 'עברית', und: 'Unknown',
};
const ISO1: Record<string, string> = { en: 'eng', no: 'nor', nb: 'nob', nn: 'nno', sv: 'swe', da: 'dan', fi: 'fin', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', ar: 'ara', tr: 'tur', el: 'ell', cs: 'ces', hu: 'hun', ro: 'ron', he: 'heb', th: 'tha', vi: 'vie', id: 'ind', uk: 'ukr' };
export function normLang(l?: string): string {
  if (!l) return 'und';
  const x = l.toLowerCase().split(/[-_]/)[0];
  if (x.length === 2) return ISO1[x] || 'und';
  if (x === 'ger') return 'deu'; if (x === 'fre') return 'fra'; if (x === 'dut') return 'nld'; if (x === 'gre') return 'ell'; if (x === 'cze') return 'ces'; if (x === 'rum') return 'ron'; if (x === 'chi') return 'zho';
  if (x.length === 3) return x;
  for (const [code, name] of Object.entries(LANG_NAMES)) if (name.toLowerCase() === x) return code;
  return 'und';
}
function langLabel(code: string): string { return LANG_NAMES[code] || code; }
const isNor = (c: string) => c === 'nor' || c === 'nob' || c === 'nno';
const sameLang = (a: string, b: string) => a === b || (isNor(a) && isNor(b));

/** Languages from an Accept-Language header, best first, as ISO-639-2. */
export function acceptLanguages(header?: string): string[] {
  if (!header) return [];
  return header.split(',')
    .map((part) => { const [tag, q] = part.trim().split(';q='); return { tag: tag.trim(), q: q ? Number(q) : 1 }; })
    .filter((x) => x.tag && x.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((x) => normLang(x.tag))
    .filter((c, i, arr) => c !== 'und' && arr.indexOf(c) === i);
}

/** Order: English, then the configured languages, then the browser's own
 *  languages (the viewer's native tongue), then everything else alphabetically. */
function langOrder(acceptLanguage?: string): (code: string) => number {
  const prefs = ['eng', ...getState().settings.subLangs, ...acceptLanguages(acceptLanguage)];
  return (code) => { const i = prefs.findIndex((p) => sameLang(p, code)); return i < 0 ? 99 : i; };
}

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

function guessLangFromName(name: string): string {
  const base = name.replace(/\.(srt|vtt)$/i, '');
  const m = base.match(/[._-]([a-z]{2,3})$/i);
  if (m) { const c = normLang(m[1]); if (c !== 'und') return c; }
  for (const [code, label] of Object.entries(LANG_NAMES)) if (new RegExp(`\\b${label}\\b`, 'i').test(base)) return code;
  if (/norsk|norwegian/i.test(base)) return 'nor';
  if (/english/i.test(base)) return 'eng';
  return 'und';
}

export async function listSubtitles(type: MediaType, videoId: string | undefined, t: Torrent | undefined, fileIdx: number | undefined, opts: { acceptLanguage?: string } = {}): Promise<SubtitleTrack[]> {
  const tracks: SubtitleTrack[] = [];
  const file = t && fileIdx != null ? t.files[fileIdx] : undefined;

  // 1) addon subtitles (OpenSubtitles v3 by default), with and without hash to detect hash matches
  if (videoId) {
    let videoHash: string | undefined;
    if (file) {
      openFile(t!, fileIdx!);
      try { videoHash = await oshash(file); } catch (e) { log.debug('oshash failed', { err: errMsg(e) }); }
      finally { closeFile(t!, fileIdx!); }
    }
    const plain = getAddonSubtitles(type, videoId, { filename: file?.name });
    const hashed = videoHash ? getAddonSubtitles(type, videoId, { videoHash, videoSize: file?.length, filename: file?.name }) : undefined;
    // Also ask without extras: the addon's CDN caches every exact URL on its own, and one of them can hold a stale,
    // partial answer (a new episode seen when it had two subtitles). Merging the answers covers it; they dedupe by URL.
    const bare = file ? getAddonSubtitles(type, videoId, {}) : undefined;
    const [p0, h, b] = await Promise.all([plain, hashed, bare]);
    const p = b ? [...p0, ...b] : p0;
    const plainIds = new Set(p.flatMap((a) => a.subs.map((s) => s.url)));
    const merged = new Map<string, { addon: string; url: string; lang: string; enc?: string; hashMatch: boolean; lan: boolean }>();
    for (const a of h || []) for (const s of a.subs) merged.set(s.url, { addon: a.addon, url: s.url, lang: normLang(s.lang), enc: s.SubEncoding, hashMatch: !plainIds.has(s.url), lan: a.lan });
    for (const a of p) for (const s of a.subs) if (!merged.has(s.url)) merged.set(s.url, { addon: a.addon, url: s.url, lang: normLang(s.lang), enc: s.SubEncoding, hashMatch: false, lan: a.lan });
    const perLang = new Map<string, number>();
    for (const s of [...merged.values()].sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch))) {
      const n = (perLang.get(s.lang) || 0) + 1; perLang.set(s.lang, n);
      if (n > 6) continue; // keep the list sane
      // The id carries whether the addon is on the LAN: only then may the file be (getVtt). Ids from internet addons stay as they were.
      const id = enc({ o: 'os', u: s.url, e: s.enc, ...(s.lan && { lan: 1 as const }) });
      tracks.push({ id, lang: s.lang, label: `${langLabel(s.lang)} ${n}${s.hashMatch ? ' ★' : ''}`, origin: /opensub/i.test(s.addon) ? 'opensubtitles' : 'addon', hashMatch: s.hashMatch, url: `/api/subs/file/${id}.vtt`, available: true });
    }
  }

  // 2) .srt/.vtt inside the torrent
  if (t) {
    t.files.forEach((f, i) => {
      if (!/\.(srt|vtt)$/i.test(f.name) || f.length > 5 * 1024 * 1024) return;
      const lang = guessLangFromName(f.name);
      const id = enc({ o: 't', h: t.infoHash, i });
      tracks.push({ id, lang, label: `${langLabel(lang)} (torrent) ${f.name.length > 40 ? '' : f.name}`.trim(), origin: 'torrent', url: `/api/subs/file/${id}.vtt`, available: true });
    });
  }

  // 3) embedded text tracks (extractable once the file is fully downloaded)
  if (t && file && fileIdx != null) {
    const probe = probeCached(`${t.infoHash}:${fileIdx}`);
    for (const s of probe?.subs || []) {
      if (!TEXT_SUB_CODECS.has(s.codec)) continue;
      const lang = normLang(s.lang);
      const id = enc({ o: 'e', h: t.infoHash, i: fileIdx, s: s.index });
      const done = file.progress >= 1;
      tracks.push({ id, lang, label: `${langLabel(lang)}${s.title ? ` · ${s.title}` : ''} (embedded${done ? '' : ', after download'})`, origin: 'embedded', url: `/api/subs/file/${id}.vtt`, available: done });
    }
  }

  // The best pick per language: a file shipped with the release, then a hash match, then an extractable
  // embedded track, then the first listed. The player turns the recommended one on automatically.
  const prio = (x: SubtitleTrack) => (x.origin === 'torrent' ? 0 : x.hashMatch ? 1 : x.origin === 'embedded' ? 2 : 3);
  const seenLang = new Set<string>();
  for (const x of [...tracks].filter((x) => x.available).sort((a, b) => prio(a) - prio(b))) { if (!seenLang.has(x.lang)) { seenLang.add(x.lang); x.recommended = true; } }
  const rank = langOrder(opts.acceptLanguage);
  return tracks.sort((a, b) => rank(a.lang) - rank(b.lang) || langLabel(a.lang).localeCompare(langLabel(b.lang)) || Number(b.recommended || 0) - Number(a.recommended || 0) || Number(b.hashMatch || 0) - Number(a.hashMatch || 0) || a.origin.localeCompare(b.origin));
}

/** Largest remote subtitle Kino will download. Real ones are well under 1 MB. */
const SUB_MAX_BYTES = 5 * 1024 * 1024;
const notFound = (msg: string) => Object.assign(new Error(msg), { status: 404 });

/**
 * Resolve a track id to WebVTT text (cached on disk), then apply offset. The disk cache is read first, so an
 * unsigned id saved before ids were signed still plays what it cached; anything else needs a signed id.
 */
export async function getVtt(id: string, offsetMs = 0, torrentOf: (h: string) => Torrent | undefined): Promise<string> {
  maybePrune();
  const cp = cachePath(id);
  let vtt = readCached(cp);
  if (!vtt) {
    const k = decodeSubId(id);
    if (k.o === 'os') {
      // A URL an addon named: a private target only when that addon is on the LAN itself, every redirect checked.
      const { buf } = await fetchText(k.u, 20_000, { maxBytes: SUB_MAX_BYTES, allowPrivate: k.lan === 1, what: 'subtitle' });
      vtt = convert(decodeSubtitle(buf, k.e));
    } else if (k.o === 't') {
      const t = torrentOf(k.h); if (!t) throw notFound('torrent not loaded');
      const f = t.files[k.i]; if (!f) throw notFound('subtitle file missing');
      openFile(t, k.i);
      try {
        const chunks: Buffer[] = []; for await (const c of f.createReadStream()) chunks.push(c as Buffer);
        vtt = convert(decodeSubtitle(Buffer.concat(chunks)));
      } finally { closeFile(t, k.i); }
    } else {
      const t = torrentOf(k.h); if (!t) throw notFound('torrent not loaded');
      const f = t.files[k.i]; if (!f) throw notFound('video file missing');
      if (f.progress < 1) throw httpError(409, 'Embedded subtitles are available once the file has fully downloaded');
      const url = localFileUrl(k.h, k.i);
      vtt = await new Promise<string>((resolve, reject) => {
        const fail = (e: unknown) => reject(new Error(startFailure('ffmpeg', e)));
        // An unknown errno (a binary for another CPU) throws here instead of reaching the callback.
        try {
          killOnShutdown(execFile(binPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', url, '-map', `0:${k.s}`, '-f', 'webvtt', '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000, killSignal: 'SIGKILL' },
            (err, stdout, stderr) => err ? (isSpawnError(err) ? fail(err) : reject(new Error(`extract failed: ${stderr?.toString().trim() || err.message}`))) : resolve(stdout.toString())));
        } catch (e) { fail(e); }
      });
      vtt = convert(vtt); // normalise
    }
    try { writeCached(cp, vtt); } catch (e) { log.warn('could not cache subtitle', { err: errMsg(e) }); }   // still serve it
  }
  return offsetMs ? convert(vtt, offsetMs) : vtt;
}
