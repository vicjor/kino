import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIntroJump, introFromChapters, dialogue, gaps, anchorFor, introFromSamples, estimateIntro, pushIntro } from '../server/media/intro.ts';

const D = 3000;
/** Dialogue every 5 s except inside the quiet stretches given. */
function talk(quiet: [number, number][], until = 1200) {
  const out: { start: number; end: number; text: string }[] = [];
  for (let t = 1; t < until; t += 5) if (!quiet.some(([a, b]) => t + 3 > a && t < b)) out.push({ start: t, end: t + 3, text: 'Line' });
  return out;
}

test('isIntroJump: early, a quarter minute to three minutes', () => {
  assert.equal(isIntroJump(60, 150), true);
  assert.equal(isIntroJump(60, 70), false, 'ten seconds is a nudge');
  assert.equal(isIntroJump(60, 400), false, 'five minutes is skipping a scene');
  assert.equal(isIntroJump(1500, 1590), false, 'too late in the episode');
});

test('introFromChapters: a named chapter near the start', () => {
  assert.deepEqual(introFromChapters([{ start: 0, end: 90 }, { start: 90, end: 150, title: 'Opening' }, { start: 150, end: 3000 }], D), { start: 90, end: 150 });
  assert.deepEqual(introFromChapters([{ start: 0, end: 60, title: 'Intro' }, { start: 60, end: 3000 }], D), { start: 0, end: 60 });
  assert.equal(introFromChapters([{ start: 0, end: 2000 }, { start: 2000, end: 3000, title: 'Opening night' }], D), undefined, 'late chapters are not the intro');
  assert.equal(introFromChapters([{ start: 0, end: 600, title: 'Introduction' }], D), undefined, 'the word has to stand alone, and ten minutes is not titles');
  assert.equal(introFromChapters(undefined, D), undefined);
});

test('dialogue drops song lyrics and sound cues', () => {
  const d = dialogue([{ start: 5, end: 6, text: '♪ theme song ♪' }, { start: 1, end: 2, text: 'Hello.' }, { start: 7, end: 8, text: '[door slams]' }, { start: 9, end: 10, text: '<i>Where were you?</i>' }]);
  assert.deepEqual(d.map((l) => l.text), ['Hello.', '<i>Where were you?</i>']);
});

test('gaps and anchorFor find the quiet stretch and the line after it', () => {
  const lines = talk([[100, 190]]);
  const g = gaps(lines).find(([a]) => a > 50)!;
  assert.ok(g[0] <= 100 && g[1] >= 190 && g[1] - g[0] < 100);
  assert.equal(anchorFor(lines, 180), g[1] - 180);
  assert.equal(anchorFor([], 180), undefined);
  assert.equal(anchorFor([{ start: 600, end: 603 }], 180), undefined, 'dialogue seven minutes later says nothing');
});

test('introFromSamples: the same titles after a longer cold open are found through the dialogue', () => {
  // Episode 1: titles 100..190, you skipped 100 -> 185, dialogue came back 6 s after.
  const ep1 = talk([[100, 190]]);
  const sample = { start: 100, end: 185, anchor: anchorFor(ep1, 185) };
  // Episode 2: the cold open runs two minutes longer, titles at 220..310.
  const ep2 = talk([[220, 310]]);
  const est = introFromSamples([sample], ep2)!;
  assert.equal(est.source, 'subtitles');
  assert.equal(est.confidence, 'medium');
  assert.ok(Math.abs(est.end! - 305) <= 5, `end ${est.end}`);
  assert.ok(Math.abs(est.start! - 220) <= 5, `start ${est.start}`);
});

test('introFromSamples: plain window only when earlier skips agree', () => {
  assert.deepEqual(introFromSamples([{ start: 60, end: 120 }, { start: 64, end: 122 }]), { start: 62, end: 121, source: 'learned', confidence: 'high' });
  assert.deepEqual(introFromSamples([{ start: 60, end: 120 }]), { start: 60, end: 120, source: 'learned', confidence: 'low' });
  assert.equal(introFromSamples([{ start: 60, end: 120 }, { start: 300, end: 360 }]), undefined, 'cold opens that vary need dialogue to line up');
  assert.equal(introFromSamples([{ start: 60, end: 900 }]), undefined, 'not an intro skip');
  assert.equal(introFromSamples(undefined), undefined);
});

test('estimateIntro: chapters first, then what you taught it, else nothing', () => {
  assert.equal(estimateIntro({ duration: D, chapters: [{ start: 30, end: 90, title: 'Intro' }], samples: [{ start: 200, end: 260 }] }).source, 'chapter');
  assert.equal(estimateIntro({ duration: D, samples: [{ start: 200, end: 260 }] }).source, 'learned');
  assert.deepEqual(estimateIntro({ duration: D }), { source: 'none', confidence: 'none' });
});

test('pushIntro keeps the last five, rounded', () => {
  const five = [1, 2, 3, 4, 5].map((i) => ({ start: i, end: i + 60 }));
  assert.deepEqual(pushIntro(five, { start: 6.4, end: 66.6, anchor: 3.14 }).map((s) => s.start), [2, 3, 4, 5, 6]);
  assert.deepEqual(pushIntro(undefined, { start: 10.2, end: 70.7, anchor: 3.14 }), [{ start: 10, end: 71, anchor: 3.1 }]);
});
