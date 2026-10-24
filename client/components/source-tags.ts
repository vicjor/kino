import type { Source, StreamsResponse } from '../../server/types.js';

/**
 * One-word labels shown on a source row: Best pick (the scorer's choice), Most reliable (the most headroom: its swarm
 * delivers the file the most times over in its running time, so the least likely to buffer), Best 4K. Headroom is the
 * server scorer's own number (server/score.ts headroom), so the label and the pick follow one rule.
 */
export function sourceTags(data: StreamsResponse): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  const add = (id: string, t: string) => tags.set(id, [...(tags.get(id) || []), t]);
  if (data.auto) add(data.auto, 'Best pick');
  const room = (s: Source) => s.headroom ?? 0;
  const candidates = data.sources.filter((s) => s.score > 0 && !s.seedersEstimated && (s.seeders ?? 0) >= 8 && s.resolution !== '480p' && s.resolution !== 'other' && room(s) > 0);
  const reliable = candidates.sort((a, b) => room(b) - room(a))[0];
  if (reliable) add(reliable.id, 'Most reliable');
  const uhd = data.sources.find((s) => s.score > 0 && s.resolution === '2160p');
  if (uhd) add(uhd.id, 'Best 4K');
  return tags;
}

/** One TV's verdict on a release, from the release name alone (the file is probed only once it plays). */
export interface CastFit { ok: 'yes' | 'meh' | 'no'; text: string; why?: string }

/**
 * Will this file play on that TV? Two very different receivers:
 *   cast   the older Chromecast: H.264 + AAC only. Anything else costs a transcode on the Mac; 4K HEVC is too much.
 *   dlna   the LG TV pulls the raw file and decodes it itself: MKV, HEVC, HDR and 5.1 are fine. AV1 depends on
 *          the model, and LG dropped DTS on 2019 to 2022 sets, so those get a caution rather than a promise.
 */
export function castFit(s: Source, kind: 'cast' | 'dlna'): CastFit {
  const hevc = s.codec === 'hevc' || s.codec === 'av1';
  if (kind === 'dlna') {
    if (s.codec === 'av1') return { ok: 'meh', text: 'AV1, may not play', why: 'Only newer LG models decode AV1.' };
    if (s.audio && /DTS|TrueHD/i.test(s.audio)) return { ok: 'meh', text: 'DTS may be silent', why: 'LG TVs from 2019 to 2022 have no DTS or TrueHD decoder. Picture plays, sound may not.' };
    return { ok: 'yes', text: 'plays' };
  }
  if (s.resolution === '2160p' && hevc) return { ok: 'no', text: 'too heavy', why: 'The Mac cannot convert 4K HEVC fast enough for this TV. Pick a 1080p source.' };
  const parts: string[] = [];
  if (hevc) parts.push(`the ${s.codec!.toUpperCase()} video`);
  if (s.hdr) parts.push('the HDR picture');
  if (parts.length) return { ok: 'meh', text: 'transcodes', why: `The Mac converts ${parts.join(' and ')} before it reaches the TV.` };
  if (s.codec === 'h264') {
    const audio = s.audio && /DTS|TrueHD|Atmos|DD|AC3|E-?AC-?3|FLAC/i.test(s.audio);
    return { ok: 'yes', text: 'plays', why: audio ? 'Video goes straight through, the audio is re-encoded to AAC.' : undefined };
  }
  return { ok: 'meh', text: 'may transcode', why: 'The release name does not say which codec it uses.' };
}
