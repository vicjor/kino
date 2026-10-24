/**
 * The "g" chords (g h, g s, g l ...) belong to the command palette, but other window listeners (the cast keys)
 * bind the same letters. They ask chordPending() and step aside for the key that finishes a chord.
 */
export const CHORD_MS = 900;

let startedAt = 0;
let closer: object | null = null;

/** A bare "g" was pressed: the next key within CHORD_MS belongs to the chord. */
export function startChord(now = Date.now()): void { startedAt = now; closer = null; }

/**
 * The chord is over. The key that ended it stays claimed, so a listener that runs after the palette for the
 * same keydown still sees the chord as pending.
 */
export function endChord(e: object): void { startedAt = 0; closer = e; }

/** True for CHORD_MS after a bare "g", and for the keydown that completes the chord. */
export function chordPending(e?: object, now = Date.now()): boolean {
  return (!!e && e === closer) || (startedAt > 0 && now - startedAt < CHORD_MS);
}
