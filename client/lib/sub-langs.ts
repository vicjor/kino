import { chosenFirst } from './format';

/** The server lists English subtitles first whatever the settings say (langOrder in server/subs/index.ts). */
export const ALWAYS_FIRST = 'eng';

/** Chips to tap: the chosen languages in their order, then the rest. English is not one of them: it is always included. */
export const choosableLangs = (chosen: readonly string[], all: readonly string[]): string[] =>
  chosenFirst([...chosen], [...all]).filter((c) => c !== ALWAYS_FIRST);

/**
 * One tap on a chip: on goes off, off goes to the end. English never changes, so what is saved keeps it
 * exactly where it was (it still decides automatic subtitles when it comes first).
 */
export function toggleLang(chosen: readonly string[], code: string): string[] {
  if (code === ALWAYS_FIRST) return [...chosen];
  return chosen.includes(code) ? chosen.filter((x) => x !== code) : [...chosen, code];
}
