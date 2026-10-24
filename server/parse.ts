import type { Source } from './types.js';

/** Raw stream object as returned by a Stremio stream addon. */
export interface AddonStream {
  name?: string; title?: string; description?: string;
  infoHash?: string; fileIdx?: number; url?: string; sources?: string[];
  behaviorHints?: { bingeGroup?: string; filename?: string; videoSize?: number; notWebReady?: boolean };
}

/** The info line (seeds, size, provider). An alternation, not a class: a class would also hold the bare U+FE0F of ⚙️ and match any emoji with it (❤️). */
const EMOJI_LINE = /👤|💾|⚙\uFE0F?|🌐/u;
/** Dots/underscores to spaces, but keep digit.digit (5.1, HDR10+). */
function norm(s: string): string { return s.replace(/_/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' '); }

export function parseSize(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(n * mult[unit]);
}

function parseResolution(s: string): Source['resolution'] | undefined {
  const t = s.toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(t)) return '2160p';
  if (/\b1080[pi]\b/.test(t)) return '1080p';
  if (/\b720p\b/.test(t)) return '720p';
  if (/\b(480p|576p|dvdrip|sdtv)\b/.test(t)) return '480p';
  return undefined;
}

/**
 * x264, H264, H.264, H 264 (names with spaces for dots), H-264 and x264_GROUP all count: norm turns dots and underscores
 * into spaces. So VC.1 and MPEG.2 arrive as "vc 1" and "mpeg 2". AVCHD is H.264 too (the camcorder and disc format).
 */
export function parseCodec(s: string): Source['codec'] | undefined {
  const t = norm(s).toLowerCase();
  if (/\b([xh][ -]?265|hevc)\b/.test(t)) return 'hevc';
  if (/\bav1\b/.test(t)) return 'av1';
  if (/\b([xh][ -]?264|avc|avchd)\b/.test(t)) return 'h264';
  if (/\b(xvid|divx|vc[ -]?1|mpeg[ -]?2)\b/.test(t)) return 'other';
  return undefined;
}

function parseHdr(s: string): string | undefined {
  const t = norm(s);
  const parts: string[] = [];
  if (/\b(dolby ?vision|dovi|\bdv\b)\b/i.test(t)) parts.push('DV');
  if (/\bhdr10\+|hdr10plus\b/i.test(t)) parts.push('HDR10+');
  else if (/\bhdr(10)?\b/i.test(t)) parts.push('HDR');
  return parts.length ? parts.join('+') : undefined;
}

export function parseAudio(s: string): string | undefined {
  const t = norm(s);
  const found: string[] = [];
  if (/\batmos\b/i.test(t)) found.push('Atmos');
  if (/\btrue ?hd\b/i.test(t)) found.push('TrueHD');
  if (/\bdts[- ]?hd\b/i.test(t)) found.push('DTS-HD');
  else if (/\bdts\b/i.test(t)) found.push('DTS');
  const ddp = t.match(/\b(ddp|dd\+|eac3|e-ac-?3)\s?(\d\.\d)?/i);
  if (ddp) found.push(`DDP${ddp[2] ? ddp[2] : ''}`);
  else {
    const dd = t.match(/\b(dd|ac-?3|dolby digital)\s?(\d\.\d)?/i);
    if (dd) found.push(`DD${dd[2] ? dd[2] : ''}`);
  }
  if (/\baac\b/i.test(t)) found.push('AAC');
  if (/\bopus\b/i.test(t)) found.push('Opus');
  if (!found.length) {
    const ch = t.match(/\b([257])\.[01]\b/);
    if (ch) found.push(ch[0]);
  }
  return found.length ? found.join(' ') : undefined;
}

/** Same list as VIDEO_EXT in torrent.ts (not imported: that module pulls in the torrent client), less `ts`. */
const VIDEO_EXTS = 'mkv|mp4|m4v|avi|mov|webm|m2ts|wmv|flv';
/**
 * A release name can itself be a filename (a single-file torrent is named after its file), so it drops a video
 * extension that ends a word too, but `.ts` only in lower case: a release name ending in an upper case TS means telesync.
 */
const RELEASE_EXT = new RegExp(`\\.(?:${VIDEO_EXTS})(?=\\s|$)`, 'gi');
function stripReleaseExt(s: string): string { return s.replace(RELEASE_EXT, '').replace(/\.ts(?=\s|$)/g, ''); }
/** A filename's own extension, in any case: on a file `.TS` is an MPEG transport stream, never telesync. */
const FILE_EXT = new RegExp(`\\.(?:${VIDEO_EXTS}|ts)$`, 'i');
export function stripFileExt(filename: string): string { return filename.trim().replace(FILE_EXT, ''); }

/** Tags in the order they are tried: the first that matches wins. */
const SOURCE_TAGS: [RegExp, string][] = [
  [/\bremux\b/i, 'REMUX'], [/\b(blu-?ray|bdrip|brrip|bdremux)\b/i, 'BluRay'], [/\bweb-?dl\b/i, 'WEB-DL'], [/\bweb-?rip\b/i, 'WEBRip'], [/\bweb\b/i, 'WEB'],
  [/\b(hdtv|pdtv)\b/i, 'HDTV'], [/\b(hdts|hd-ts|ts|telesync|hdtc|hd-tc|telecine)\b/i, 'TS'], [/\b(cam|camrip|hdcam|hd-cam)\b/i, 'CAM'], [/\b(dvdrip|dvd)\b/i, 'DVD'],
];
const tagRank = (s: string): number => { const t = norm(s); const i = SOURCE_TAGS.findIndex(([re]) => re.test(t)); return i < 0 ? SOURCE_TAGS.length : i; };

/** Source tag of a release name (or any text that is not a bare filename). */
export function parseSourceTag(s: string): string | undefined { return SOURCE_TAGS[tagRank(stripReleaseExt(s))]?.[1]; }

/**
 * Source tag of a stream: release name, filename and any other text tagged apart, so only the filename loses its
 * extension in any case. The tag earliest in SOURCE_TAGS wins, as when they were one string.
 */
export function sourceTagOf(release: string, filename?: string, more = ''): string | undefined {
  return SOURCE_TAGS[Math.min(tagRank(stripReleaseExt(release)), filename ? tagRank(stripFileExt(filename)) : SOURCE_TAGS.length, tagRank(stripReleaseExt(more)))]?.[1];
}

const NOT_GROUPS = /^(bluray|blu-ray|bdrip|brrip|remux|web|webrip|webdl|web-dl|hdtv|x264|x265|h264|h265|hevc|avc|aac|ac3|ddp|dts|atmos|1080p|720p|2160p|4k|hdr|dv|10bit|8bit|multi|dual|sub|subs|eng|ita|nor|swe)$/i;
/** A site's address tacked on the end in brackets or parentheses: "[site.org]", "(www.site.com)". */
const SITE_SUFFIX = /\s*[[(](?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}[\])]\s*$/i;
/**
 * The release group: "[GRP]" at the end, or "-GRP" after a site suffix and any extension are gone. A dash glued to the
 * name may have a space after it ("H 265- GRP", a name with spaces for dots), but " - Title" is a title, not a group.
 */
export function parseGroup(release: string): string | undefined {
  const r = stripReleaseExt(stripReleaseExt(release.trim()).replace(SITE_SUFFIX, ''));
  const bracket = r.match(/\[([A-Za-z0-9]+)\]\s*$/);
  if (bracket) return bracket[1];
  const dash = r.match(/(?:(?<!\s)-\s*|-)([A-Za-z0-9]{2,20})$/);
  if (dash && !/^\d+$/.test(dash[1]) && !NOT_GROUPS.test(dash[1])) return dash[1];
  return undefined;
}

// Release names announce dubs and dual audio in a hundred ways. Pick out what we can:
// the point is to keep a Czech or Tamil dub from becoming "best pick" for an English show.
const LANG_MARKS: [RegExp, string][] = [
  [/\b(ita|italian|italiano)\b/i, 'ita'], [/\b(fre|fra|french|francais|français|truefrench|vff|vfq|vf2?|vostfr)\b/i, 'fra'], [/\b(ger|german|deutsch|deu)\b/i, 'deu'],
  [/\b(spa|spanish|espanol|español|castellano|latino|esp)\b/i, 'spa'], [/\b(por|portuguese|portugues|português|dublado|pt-?br)\b/i, 'por'], [/\b(rus|russian|русский|dub\.?rus)\b/i, 'rus'],
  [/\b(pol|polish|polski|lektor|dubbing pl|pldub|pl)\b/i, 'pol'], [/\b(cz|cze|ces|czech|česky|cesky|dabing)\b/i, 'ces'], [/\b(hun|hungarian|magyar)\b/i, 'hun'],
  [/\b(tur|turkish|türkçe|turkce)\b/i, 'tur'], [/\b(hin|hindi|tamil|telugu|malayalam|kannada|bengali|marathi)\b/i, 'hin'], [/\b(kor|korean)\b/i, 'kor'], [/\b(jpn|jap|japanese)\b/i, 'jpn'],
  [/\b(chi|zho|chinese|mandarin|cantonese)\b/i, 'zho'], [/\b(arabic)\b/i, 'ara'], [/\b(dut|nld|dutch|nederlands)\b/i, 'nld'], [/\b(swe|swedish|svenska)\b/i, 'swe'], [/\b(danish)\b/i, 'dan'], [/\b(finnish)\b/i, 'fin'], [/\b(norwegian|norsk)\b/i, 'nor'],
  [/\b(ukr|ukrainian)\b/i, 'ukr'], [/\b(vietnamese)\b/i, 'vie'], [/\b(thai)\b/i, 'tha'], [/\b(indonesian)\b/i, 'ind'], [/\b(hebrew)\b/i, 'heb'], [/\b(greek)\b/i, 'ell'], [/\b(romanian)\b/i, 'ron'],
];
const ENGLISH = /\b(eng|english|en)\b/i;
const DUAL = /\b(dual|multi|multi-?lang|multi-?audio|dual-?audio|2audio|3audio)\b/i;

/** Announced audio languages + whether the default track is likely not English. */
export function parseLangs(hay: string): { langs: string[]; foreignAudio?: Source['foreignAudio'] } {
  const text = hay.replace(/[._]/g, ' ');
  const langs = new Set<string>();
  for (const [re, code] of LANG_MARKS) if (re.test(text)) langs.add(code);
  if (/[\u0400-\u04FF]/.test(text)) langs.add('rus');                    // Cyrillic title
  if (/[ąęłńśźżĄĘŁŃŚŹŻ]/.test(text)) langs.add('pol');                    // Polish diacritics
  if (/[ěščřžýůĚŠČŘŽÝŮ]/.test(text)) langs.add('ces');                    // Czech diacritics
  const english = ENGLISH.test(text);
  const dual = DUAL.test(text) || /\b[A-Z]{2,3}\/[A-Z]{2,3}\b/.test(hay) || (langs.size > 0 && english);
  // "nordic"/"swesub" style markers are about subtitles, not audio: only treat as foreign when nothing says English
  const foreign = [...langs].filter((l) => l !== 'eng');
  let foreignAudio: Source['foreignAudio'];
  if (foreign.length) foreignAudio = dual || english ? 'dual' : 'dub';
  return { langs: [...langs], foreignAudio };
}

/**
 * What a stream's names say about it: the release name, the file name, the addon's other name lines (`more`) and its
 * binge group. The resolution is left out when the names give none.
 */
function nameFields(releaseName: string, filename: string | undefined, more: string, bingeGroup: string | undefined) {
  const hay = `${releaseName} ${filename || ''} ${more}`;
  const binge = bingeGroup?.replace(/\|/g, ' ');
  const { langs, foreignAudio } = parseLangs(`${releaseName} ${filename || ''}`);
  return {
    resolution: parseResolution(hay),
    codec: parseCodec(hay) || (binge ? parseCodec(binge) : undefined),
    hdr: parseHdr(hay) || (binge && parseHdr(binge)) || undefined,
    audio: parseAudio(hay),
    sourceTag: sourceTagOf(releaseName, filename, more),
    group: parseGroup(releaseName),
    langs: langs.length ? langs : undefined,
    foreignAudio,
  };
}

/**
 * A stored source read again from its names by the parser as it is now (scripts/pick-agreement.ts --reparse), to
 * measure a parser change on recorded picks. Seeders, size and provider stay. A resolution the names do not give stays
 * too: it may have come from the addon's own name line, which a stored source does not keep.
 */
export function reparse(s: Source): Source {
  const named = nameFields(s.releaseName, s.filename, '', s.bingeGroup);
  return { ...s, ...named, resolution: named.resolution || s.resolution };
}

/** Parse one addon stream into a Source. Returns undefined for non-torrent streams. */
export function parseStream(st: AddonStream, addonName: string): Source | undefined {
  if (!st.infoHash) return undefined;
  const infoHash = st.infoHash.toLowerCase();
  const nameLines = (st.name || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const body = st.title || st.description || '';
  const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
  const infoLine = lines.find((l) => EMOJI_LINE.test(l)) || '';
  const textLines = lines.filter((l) => !EMOJI_LINE.test(l));
  const releaseName = textLines[0] || nameLines.join(' ') || infoHash;
  const filename = st.behaviorHints?.filename || (textLines.length > 1 ? textLines[textLines.length - 1] : undefined);

  const seeders = infoLine.match(/👤\s*(\d+)/u)?.[1];
  const size = infoLine.match(/💾\s*([\d.,]+\s*[KMGT]?B)/iu)?.[1];
  const provider = infoLine.match(/⚙\uFE0F?\s*([^👤💾🌐]+?)\s*$/u)?.[1]?.trim() || infoLine.match(/⚙\uFE0F?\s*([^\s👤💾🌐]+)/u)?.[1];

  const bingeGroup = st.behaviorHints?.bingeGroup;
  const named = nameFields(releaseName, filename, nameLines.slice(1).join(' '), bingeGroup);
  const src: Source = {
    id: `${infoHash}:${st.fileIdx ?? -1}`,
    infoHash,
    fileIdx: st.fileIdx,
    addon: nameLines[0] || addonName,
    provider,
    releaseName,
    filename,
    seeders: seeders != null ? Number(seeders) : undefined,
    sizeBytes: parseSize(size) ?? st.behaviorHints?.videoSize,
    ...named,
    resolution: named.resolution || parseResolution(nameLines.join(' ')) || 'other',
    bingeGroup,
    score: 0,
    warnings: [],
  };
  return src;
}

/**
 * Some providers do not report seeders; the addon fills in one fixed placeholder number for every release. Flag
 * those so the UI does not show a made-up count and the scorer does not trust it. Rule: two or more sources from
 * one provider that all carry the exact same count.
 */
export function flagPlaceholderSeeds(sources: Source[]): Source[] {
  const byProvider = new Map<string, Source[]>();
  for (const s of sources) { if (s.seeders == null || !s.provider) continue; const k = s.provider.toLowerCase(); byProvider.set(k, [...(byProvider.get(k) || []), s]); }
  for (const list of byProvider.values()) {
    if (list.length >= 2 && list.every((s) => s.seeders === list[0].seeders)) for (const s of list) s.seedersEstimated = true;
  }
  return sources;
}

/** Replace addon figures with what the trackers reported (see scrape.ts). Hashes nobody answered for keep the addon's number. */
export function applyLiveSeeds(sources: Source[], live: Map<string, number>): Source[] {
  for (const s of sources) {
    const n = live.get(s.infoHash.toLowerCase());
    if (n == null || n < 0) continue;
    if (s.seeders != null && !s.seedersEstimated && !s.seedersLive) s.seedersAddon = s.seeders;
    s.seeders = n; s.seedersLive = true; delete s.seedersEstimated;
  }
  return sources;
}
