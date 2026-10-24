/**
 * How often the automatic source pick (server/score.ts) matches the owner's own choice. Local data only: never commit
 * a dataset, a choices list or picks.jsonl (release names, the owner's history).
 *
 *   node --import tsx scripts/pick-agreement.ts choices --state <copy of state.json> --out <choices.json>
 *     the source each watched title was played from: a starting list to edit by hand (set `target`, mark `how` it was
 *     picked: manual, auto-next, same-pack, unknown, test; list releases tried and dropped in `rejected`).
 *   node --import tsx scripts/pick-agreement.ts collect --server http://localhost:<port> --choices <choices.json> --out <dataset.json>
 *     asks a side server's streams route for every title, one every two seconds, and keeps every candidate's features
 *     and the Auto pick of that build with the choice. Run the side server from a worktree build with KINO_DATA on a
 *     copy of state.json. Never point it at the Kino people are watching.
 *   node --import tsx scripts/pick-agreement.ts report --data <dataset.json> [--picks <KINO_DATA/picks.jsonl>] [--reparse]
 *     top-1 agreement and the chosen release's rank, then (the stored Auto) and now (server/score.ts as it is), and every
 *     disagreement with the numbers behind it. picks.jsonl holds every release played or cast from a source list since
 *     the log came in, with Auto's pick at the time: pass it to measure on real use, no collecting needed. Once it has
 *     outcome lines, also how many picks played here ran into trouble (stalled, switched away, stopped), per who chose.
 *     --data also takes test/fixtures/pick-cases.json (the scrubbed cases score.test.ts checks). --reparse reads every
 *     release name again with server/parse.ts as it is now before scoring, to measure a parser change.
 *   node --import tsx scripts/pick-agreement.ts tune --data <dataset.json> [--picks <picks.jsonl>] [--reparse]
 *     a small grid over the four tuned PICK parameters, and a leave-one-title-out check of the winner.
 */
import fs from 'node:fs';
import { rankSources, pickAuto, PICK, type PickParams, type DecodeCaps } from '../server/score.ts';
import { runtimeSeconds } from '../server/meta.ts';
import { reparse } from '../server/parse.ts';
import type { MediaType, Source, Target } from '../server/types.ts';

/** One title with what was played and the candidates on offer. */
export interface PickCase {
  videoId: string; type: MediaType; target: Target;
  /** Codecs the browser said it decodes besides H.264 (the pick log keeps them since they reached the ranking). */
  caps?: DecodeCaps;
  /** How the release got picked: manual, auto-next (Kino chose), same-pack (a later episode of a pack already playing), unknown, test, log. */
  how?: string;
  chosen: { infoHash: string; fileIdx?: number };
  /** Releases tried for this title and dropped before the chosen one. */
  rejected?: string[];
  runtimeSec?: number;
  /** The Auto pick when the case was recorded. */
  autoThen?: string;
  /** In the order the streams route ranked them then. */
  sources: Source[];
  /** What the case shows, in words (the scrubbed fixture has one per case). */
  note?: string;
}

/** "hash:fileIdx" as the pick log and the fixture write it; a file index below 0 means none. */
const chosenOf = (id: string): PickCase['chosen'] => {
  const [infoHash, idx] = String(id).split(':');
  return { infoHash, fileIdx: Number(idx) >= 0 ? Number(idx) : undefined };
};

type StoredCase = Omit<PickCase, 'videoId' | 'chosen' | 'sources'> & { videoId?: string; chosen: PickCase['chosen'] | string; sources: Partial<Source>[] };
/**
 * Cases from a collected dataset ({ cases }), a bare list of them, or test/fixtures/pick-cases.json: there `chosen` is
 * "hash:fileIdx", a case has no videoId (each counts as a title of its own) and a source may lack the fields scoring fills in.
 */
export function casesFrom(json: unknown): PickCase[] {
  const list = (Array.isArray(json) ? json : (json as { cases?: unknown } | null)?.cases) as StoredCase[] | undefined;
  return (Array.isArray(list) ? list : []).map((c, i) => ({ ...c, videoId: c.videoId ?? `case${i + 1}`, chosen: typeof c.chosen === 'string' ? chosenOf(c.chosen) : c.chosen,
    sources: c.sources.map((s) => ({ addon: 'Local', ...s, score: 0, warnings: [] }) as Source) }));
}

/** Every release name read again by the parser as it is now (server/parse.ts reparse). */
export const reparseCases = (cases: PickCase[]): PickCase[] => cases.map((c) => ({ ...c, sources: c.sources.map(reparse) }));

/** The chosen release in a case's list: same hash, and same file when the case says which. */
export function findChosen(c: Pick<PickCase, 'chosen'>, list: Source[]): Source | undefined {
  const same = list.filter((s) => s.infoHash === c.chosen.infoHash);
  return (c.chosen.fileIdx != null ? same.find((s) => (s.fileIdx ?? 0) === c.chosen.fileIdx) : undefined) || same[0];
}

/** Rank (1 is top) of the chosen release in a list shown with Auto's pick first. */
const rankIn = (order: Source[], auto: Source | undefined, chosen: Source | undefined): number | undefined => {
  if (!chosen) return undefined;
  const list = auto ? [auto, ...order.filter((s) => s !== auto)] : order;
  return list.indexOf(chosen) + 1;
};

/** The chosen release's rank when the case was recorded: the stored order, the stored Auto first. */
export function rankThen(c: PickCase): number | undefined {
  return rankIn(c.sources, c.sources.find((s) => s.id === c.autoThen), findChosen(c, c.sources));
}

/** The chosen release's rank under server/score.ts (with params p), and what Auto picks now. */
export function judge(c: PickCase, p: PickParams = PICK): { rank?: number; auto?: Source; chosen?: Source } {
  const ranked = rankSources(c.sources.map((s) => ({ ...s, score: 0, warnings: [] })), c.target, c.type, { runtimeSec: c.runtimeSec, caps: c.caps }, p);
  const auto = pickAuto(ranked);
  const chosen = findChosen(c, ranked);
  return { rank: rankIn(ranked, auto, chosen), auto, chosen };
}

export interface Summary { n: number; top1: number; top3: number; meanRank: number }
export function summarize(ranks: (number | undefined)[]): Summary {
  const r = ranks.filter((x): x is number => x != null);
  return { n: r.length, top1: r.filter((x) => x === 1).length, top3: r.filter((x) => x <= 3).length, meanRank: r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0 };
}

/** picks.jsonl lines (server/picks.ts) as cases. A line that does not parse is skipped. */
export function readPicks(text: string): PickCase[] {
  return text.split('\n').filter(Boolean).flatMap((l): PickCase[] => {
    try {
      const p = JSON.parse(l) as { videoId: string; type: MediaType; target: Target; caps?: DecodeCaps; runtimeSec?: number; auto?: string; chosen: string; sources: Source[] };
      if (!Array.isArray(p.sources)) return [];   // an outcome line (tallyOutcomes)
      return [{ videoId: p.videoId, type: p.type, target: p.target, ...(p.caps && { caps: p.caps }), how: 'log', runtimeSec: p.runtimeSec, autoThen: p.auto, chosen: chosenOf(p.chosen), sources: p.sources.map((s) => ({ ...s, score: 0, warnings: [] })) }];
    } catch { return []; }
  });
}

/** Who chose the release: Auto (it is the release Auto picked) or the owner (another one). */
export type Chooser = 'Auto' | 'owner';
/** Picks counted, those that ran into trouble, how many of them per kind, and the seconds watched before the first trouble. */
export interface OutcomeTally { picks: number; troubled: number; kinds: Record<string, number>; watchedSec: number[] }
interface PickRow { t: number; v?: number; via?: string; auto?: string; chosen: string }
interface OutcomeRow { outcome: string; chosen: string; pickT: number; watchedSec?: number }

/**
 * What became of the picks played here, per who chose (server/picks.ts outcome lines, tied to a pick by pickT and
 * chosen). Counts the picks played in the browser from the log format that learns outcomes (v 2), and any pick an
 * outcome names. An outcome whose pick was trimmed away is left out. Undefined when the log has no outcome line at all.
 */
export function tallyOutcomes(text: string): Record<Chooser, OutcomeTally> | undefined {
  const picks = new Map<string, PickRow>(); const outs: OutcomeRow[] = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
    if (typeof o.outcome === 'string') outs.push(o as unknown as OutcomeRow);
    else if (Array.isArray(o.sources)) picks.set(`${o.t}|${o.chosen}`, o as unknown as PickRow);
  }
  if (!outs.length) return undefined;
  const per = new Map<PickRow, OutcomeRow[]>();
  for (const o of outs) { const p = picks.get(`${o.pickT}|${o.chosen}`); if (p) per.set(p, [...(per.get(p) || []), o]); }
  const empty = (): OutcomeTally => ({ picks: 0, troubled: 0, kinds: {}, watchedSec: [] });
  const out: Record<Chooser, OutcomeTally> = { Auto: empty(), owner: empty() };
  for (const p of picks.values()) {
    const got = per.get(p);
    if (!got && !((p.v ?? 1) >= 2 && p.via === 'play')) continue;
    const t = out[p.auto && p.chosen === p.auto ? 'Auto' : 'owner'];
    t.picks++;
    if (!got) continue;
    t.troubled++;
    for (const k of new Set(got.map((o) => o.outcome))) t.kinds[k] = (t.kinds[k] || 0) + 1;
    t.watchedSec.push(Math.min(...got.map((o) => o.watchedSec ?? 0)));
  }
  return out;
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** The report's lines for tallyOutcomes: per who chose, how many picks ran into trouble, which kinds, and how soon. */
export function outcomeReport(t: Record<Chooser, OutcomeTally>): string[] {
  return ['\noutcomes, picks played here since the log learned them:', ...Object.entries(t).map(([who, x]) => {
    const kinds = Object.entries(x.kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', ');
    return `  ${who.padEnd(6)} ${x.troubled} of ${x.picks} ran into trouble${x.troubled ? `: ${kinds}; median ${Math.round(median(x.watchedSec) / 60)} min watched first` : ''}`;
  })];
}

const GB = 1024 ** 3;
const brief = (s: Source | undefined): string => !s ? '-'
  : `${s.resolution} ${s.codec ?? '?'} ${s.sourceTag ?? '?'} ${((s.sizeBytes ?? 0) / GB).toFixed(2)} GB, ${s.seedersEstimated ? '?' : s.seeders ?? '-'}${s.seedersLive ? '' : ' (addon)'} seeds, headroom ${s.headroom ?? '?'}, score ${s.score}  ${s.releaseName.slice(0, 50)}`;

/** Weights for tuning: a later episode of a pack already playing, or Kino's own auto-next, says less than a pick by hand. */
const WEIGHT: Record<string, number> = { manual: 1, unknown: 1, log: 1, 'auto-next': 0.7, 'same-pack': 0.5, test: 0 };
const weight = (c: PickCase) => WEIGHT[c.how || 'unknown'] ?? 1;

/** Weighted top-1 agreement of a parameter set, and how often Auto lands on a release the owner tried and dropped. */
export function agreement(cases: PickCase[], p: PickParams = PICK): { top1: number; meanRank: number; rejected: number } {
  let w = 0, hit = 0, ranks = 0, rejected = 0;
  for (const c of cases) {
    const j = judge(c, p), wt = weight(c);
    w += wt; if (j.rank === 1) hit += wt; ranks += Math.min(j.rank ?? 10, 10) * wt;
    if (j.auto && c.rejected?.includes(j.auto.infoHash)) rejected++;
  }
  return { top1: w ? hit / w : 0, meanRank: w ? ranks / w : 0, rejected };
}

/** The tuned parameters and the values tried. Everything else in PICK is set by reasoning, not by the data. */
export const GRID: Partial<Record<keyof PickParams, number[]>> = { halfSeeds: [100, 200, 400, 800], margin: [1.5, 2, 3], headroomPts: [3, 6, 10, 15], qualityPts: [0, 2, 4, 8] };
export function gridSearch(cases: PickCase[], grid = GRID): { p: PickParams; top1: number; meanRank: number }[] {
  let sets: Partial<PickParams>[] = [{}];
  for (const [k, vals] of Object.entries(grid)) sets = sets.flatMap((s) => vals!.map((v) => ({ ...s, [k]: v })));
  // Agreement first, then a better mean rank, then fewer picks of a dropped release.
  return sets.map((g) => { const p = { ...PICK, ...g }; const a = agreement(cases, p); return { p, top1: a.top1, meanRank: a.meanRank, obj: a.top1 - 0.02 * a.meanRank - 0.03 * a.rejected }; })
    .sort((a, b) => b.obj - a.obj).map(({ p, top1, meanRank }) => ({ p, top1, meanRank }));
}

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (name: string): string => { const v = arg(name); if (!v) throw new Error(`--${name} is required`); return v; };
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
function loadCases(): PickCase[] {
  const picks = arg('picks');
  const data = arg('data') ? casesFrom(readJson<unknown>(arg('data')!)) : [];
  const cases = [...data, ...(picks && fs.existsSync(picks) ? readPicks(fs.readFileSync(picks, 'utf8')) : [])].filter((c) => findChosen(c, c.sources));
  return process.argv.includes('--reparse') ? reparseCases(cases) : cases;
}

function choices(): void {
  const st = readJson<{ progress: Record<string, { videoId: string; type: MediaType; infoHash?: string; fileIdx?: number }> }>(need('state'));
  const list = Object.values(st.progress).filter((p) => p.infoHash).map((p) => ({ videoId: p.videoId, type: p.type, target: 'browser', how: 'unknown', chosen: { infoHash: p.infoHash!, fileIdx: p.fileIdx } }));
  fs.writeFileSync(need('out'), JSON.stringify(list, null, 1));
  console.log(`${list.length} titles`);
}

async function collect(): Promise<void> {
  const server = need('server').replace(/\/$/, '');
  if (/:1234\b/.test(server)) throw new Error('refusing port 1234: that is the Kino people watch. Run a side server');
  const out: PickCase[] = [];
  for (const c of readJson<Omit<PickCase, 'sources'>[]>(need('choices'))) {
    const r = await fetch(`${server}/api/streams/${c.type}/${encodeURIComponent(c.videoId)}?target=${c.target}`).then((x) => x.json()) as { sources: Source[]; auto?: string };
    const m = await fetch(`${server}/api/meta/${c.type}/${encodeURIComponent(c.videoId.split(':')[0])}`).then((x) => x.json()).catch(() => ({})) as { meta?: { runtime?: string } };
    const sources = r.sources.map((s) => ({ ...s, score: 0, warnings: [] }));
    out.push({ ...c, runtimeSec: runtimeSeconds(m.meta?.runtime), autoThen: r.auto, sources });
    console.log(`${c.videoId}: ${sources.length} sources, the chosen one ${findChosen(c, sources) ? 'found' : 'MISSING'}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  fs.writeFileSync(need('out'), JSON.stringify({ collectedAt: Date.now(), cases: out }));
}

function report(): void {
  const cases = loadCases();
  const then: (number | undefined)[] = [], now: (number | undefined)[] = [];
  const groups = new Map<string, { then: (number | undefined)[]; now: (number | undefined)[] }>();
  for (const c of cases) {
    const j = judge(c), t = rankThen(c);
    then.push(t); now.push(j.rank);
    const g = groups.get(c.how || '?') || { then: [], now: [] }; g.then.push(t); g.now.push(j.rank); groups.set(c.how || '?', g);
    if (j.rank !== 1) console.log(`${c.videoId}${c.note ? ` (${c.note})` : ''} ${c.target} ${c.how || ''}: rank ${j.rank} of ${c.sources.length} (then ${t})\n  chose ${brief(j.chosen)}\n  auto  ${brief(j.auto)}`);
  }
  const line = (s: Summary) => `${s.top1}/${s.n} top-1, ${s.top3} top-3, mean rank ${s.meanRank.toFixed(2)}`;
  console.log(`\nthen: ${line(summarize(then))}\nnow:  ${line(summarize(now))}`);
  for (const [k, g] of groups) console.log(`  ${k.padEnd(9)} then ${line(summarize(g.then))} | now ${line(summarize(g.now))}`);
  const picks = arg('picks');
  const outcomes = picks && fs.existsSync(picks) ? tallyOutcomes(fs.readFileSync(picks, 'utf8')) : undefined;
  if (outcomes) for (const l of outcomeReport(outcomes)) console.log(l);
}

function tune(): void {
  const cases = loadCases().filter((c) => weight(c) > 0);
  const show = (p: PickParams) => JSON.stringify(Object.fromEntries(Object.keys(GRID).map((k) => [k, p[k as keyof PickParams]])));
  const best = gridSearch(cases);
  console.log(`now: ${JSON.stringify(agreement(cases))}`);
  for (const b of best.slice(0, 8)) console.log(`${show(b.p)} top-1 ${b.top1.toFixed(3)} mean rank ${b.meanRank.toFixed(2)}`);
  // Leave one title out: tune on the others, score the held-out title's cases.
  const titles = [...new Set(cases.map((c) => c.videoId.split(':')[0]))];
  let hit = 0, w = 0;
  for (const t of titles) {
    const held = cases.filter((c) => c.videoId.split(':')[0] === t);
    const p = gridSearch(cases.filter((c) => c.videoId.split(':')[0] !== t))[0].p;
    const wt = held.reduce((a, c) => a + weight(c), 0);
    hit += agreement(held, p).top1 * wt; w += wt;
  }
  console.log(`leave one title out: top-1 ${(hit / w).toFixed(3)} over ${titles.length} titles`);
}

async function main(cmd = process.argv[2]): Promise<void> {
  if (cmd === 'collect') await collect();
  else if (cmd === 'choices') choices();
  else if (cmd === 'report') report();
  else if (cmd === 'tune') tune();
  else console.log('usage: pick-agreement.ts choices | collect | report | tune (see the comment at the top)');
}
if (import.meta.main) void main();
