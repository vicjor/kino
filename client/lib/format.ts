import { episodeCode } from '../../server/episode-name.js';

/** "S2 E3". Defined once in server/episode-name.ts, which the client bundles too, so the server labels match. */
export { episodeCode };

export function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
export function fmtSpeed(bps?: number): string {
  if (!bps || bps <= 0) return '0 KB/s';
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}
export function fmtTime(s?: number): string {
  if (!s || !isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
export function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
/** "just now", "5 min ago", "1 hour ago", "3 days ago". `now` is there for tests. */
export function relTime(ms: number, now = Date.now()): string {
  const m = Math.round((now - ms) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
/**
 * "S2 E5" from a file name like Show.S02E05.1080p.mkv or Show 2x05.mkv, the way the rest of Kino labels
 * episodes; '' when the name carries no episode. Tells files in a season pack apart.
 */
export function episodeTag(name: string): string {
  const m = name.match(/(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?!\d)/i) || name.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![\da-z])/i);
  return m ? episodeCode(Number(m[1]), Number(m[2])) : '';
}
const LANG_NAMES: Record<string, string> = {
  eng: 'English', nor: 'Norwegian', nob: 'Norwegian', nno: 'Nynorsk', swe: 'Swedish', dan: 'Danish', fin: 'Finnish',
  deu: 'German', ger: 'German', fra: 'French', fre: 'French', spa: 'Spanish', ita: 'Italian', por: 'Portuguese', pob: 'Portuguese (BR)',
  nld: 'Dutch', dut: 'Dutch', pol: 'Polish', rus: 'Russian', jpn: 'Japanese', kor: 'Korean', zho: 'Chinese', chi: 'Chinese',
  ara: 'Arabic', tur: 'Turkish', ell: 'Greek', gre: 'Greek', ces: 'Czech', cze: 'Czech', hun: 'Hungarian', ron: 'Romanian', rum: 'Romanian',
  heb: 'Hebrew', tha: 'Thai', vie: 'Vietnamese', ind: 'Indonesian', ukr: 'Ukrainian', bul: 'Bulgarian', hrv: 'Croatian', srp: 'Serbian',
  slv: 'Slovenian', slk: 'Slovak', est: 'Estonian', lav: 'Latvian', lit: 'Lithuanian', isl: 'Icelandic', ice: 'Icelandic', sqi: 'Albanian', alb: 'Albanian', ben: 'Bengali', bos: 'Bosnian', cat: 'Catalan', glg: 'Galician', eus: 'Basque', baq: 'Basque', mkd: 'Macedonian', mac: 'Macedonian', msa: 'Malay', may: 'Malay', fil: 'Filipino', tgl: 'Tagalog', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', hin: 'Hindi', urd: 'Urdu', fas: 'Persian', per: 'Persian', kur: 'Kurdish', aze: 'Azerbaijani', kaz: 'Kazakh', kat: 'Georgian', geo: 'Georgian', hye: 'Armenian', arm: 'Armenian', mon: 'Mongolian', khm: 'Khmer', mya: 'Burmese', bur: 'Burmese', sin: 'Sinhala', nep: 'Nepali', swa: 'Swahili', afr: 'Afrikaans', bel: 'Belarusian', lat: 'Latin', epo: 'Esperanto', mlt: 'Maltese', gle: 'Irish', cym: 'Welsh', wel: 'Welsh', ltz: 'Luxembourgish', pan: 'Punjabi', guj: 'Gujarati', kan: 'Kannada', mar: 'Marathi', som: 'Somali', amh: 'Amharic', uzb: 'Uzbek', lao: 'Lao', pus: 'Pashto', tat: 'Tatar', ast: 'Asturian', zht: 'Chinese (Traditional)', zhe: 'Chinese/English', spl: 'Spanish (Latin America)', spn: 'Spanish (Spain)', pom: 'Portuguese (MZ)', scc: 'Serbian', slo: 'Slovak', und: 'Unknown',
};
export function langName(code: string): string {
  return LANG_NAMES[code] || LANG_NAMES[code.slice(0, 3)] || code;
}
/** Language chips: the chosen ones first, in the order they were picked (first is first choice), then the rest as listed. */
export function chosenFirst(chosen: string[], all: string[]): string[] {
  return [...new Set([...chosen, ...all])];
}
const AUDIO_FORMATS: Record<string, string> = { ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS' };
/**
 * An audio track in plain words: "Surround 5.1 · Dolby Digital", "Stereo", "Mono", "4 channels". Only formats
 * people know from their TV get named; AAC, Opus and the like add nothing a viewer picks by.
 */
export function audioDetail(codec: string, channels?: number): string {
  const ch = !channels ? '' : channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : channels === 6 ? 'Surround 5.1' : channels === 8 ? 'Surround 7.1' : `${channels} channels`;
  return [ch, AUDIO_FORMATS[codec.toLowerCase()]].filter(Boolean).join(' · ');
}
