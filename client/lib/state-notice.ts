import type { StateRepaired } from './api';

/** The last part of a path the server sent, on any platform. */
export const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The notice's heading: a repair is news, pruning alone is housekeeping. */
export function repairedTitle(r: StateRepaired): string {
  return r.repairedFields || r.droppedProgress ? 'Saved data was repaired' : 'Old entries were cleared';
}

/**
 * What a load repaired and pruned, in words. The ages follow SHORT_PROGRESS_TTL_MS (30 days) and CAST_HISTORY_TTL_MS
 * (90 days) in server/store.ts.
 */
export function repairedText(r: StateRepaired): string {
  const fixed = [
    r.repairedFields ? `fixed ${count(r.repairedFields, 'damaged part', 'damaged parts')} of its saved data` : '',
    r.droppedProgress ? `left out ${count(r.droppedProgress, 'watch position', 'watch positions')} it could not read` : '',
  ].filter(Boolean);
  const cleared = [
    r.prunedProgress ? `${count(r.prunedProgress, 'title', 'titles')} you opened for only a few seconds over a month ago` : '',
    r.prunedCastDevices ? `the play history of ${count(r.prunedCastDevices, 'TV or speaker', 'TVs or speakers')} not used for three months` : '',
  ].filter(Boolean);
  return [
    fixed.length ? `Kino ${fixed.join(' and ')}.` : '',
    cleared.length ? `${fixed.length ? 'It also cleared' : 'Kino cleared'} ${cleared.join(' and ')}.` : '',
    r.backup ? `The file from before is kept as ${fileName(r.backup)}.` : '',
  ].filter(Boolean).join(' ');
}
