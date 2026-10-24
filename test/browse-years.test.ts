import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearPicks, readYears, yearsPhrase, sameYears } from '../client/lib/years.ts';

test('yearPicks: this year and last year follow the clock', () => {
  const picks = yearPicks(new Date('2026-10-13'));
  assert.deepEqual(picks.find((p) => p.key === 'this'), { key: 'this', label: 'This year', from: 2026, to: 2026 });
  assert.deepEqual(picks.find((p) => p.key === 'last'), { key: 'last', label: 'Last year', from: 2025, to: 2025 });
  assert.deepEqual(picks.find((p) => p.key === 'recent'), { key: 'recent', label: 'Last 5 years', from: 2022, to: 2026 });
});

test('readYears: from the URL, backwards swapped, junk ignored', () => {
  assert.deepEqual(readYears(new URLSearchParams('from=2024&to=2020')), { from: 2020, to: 2024 });
  assert.deepEqual(readYears(new URLSearchParams('to=1989')), { from: undefined, to: 1989 });
  assert.equal(readYears(new URLSearchParams('from=soon')), undefined);
});

test('yearsPhrase: reads as the end of a shelf title', () => {
  assert.equal(yearsPhrase({ from: 2025, to: 2025 }), 'from 2025');
  assert.equal(yearsPhrase({ from: 2010, to: 2019 }), 'from the 2010s');
  assert.equal(yearsPhrase({ from: 2020, to: 2024 }), 'from 2020 to 2024');
  assert.equal(yearsPhrase({ from: 2015 }), 'since 2015');
  assert.equal(yearsPhrase({ to: 1989 }), 'before 1990');
  assert.equal(yearsPhrase(undefined), '');
});

test('sameYears: open ends compare equal', () => {
  assert.equal(sameYears({ to: 1989 }, { from: undefined, to: 1989 }), true);
  assert.equal(sameYears(undefined, { from: 2020 }), false);
  assert.equal(sameYears(undefined, undefined), true);
});
