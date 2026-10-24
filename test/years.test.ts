import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readYears, inYears, yearDates } from '../server/years.ts';

test('readYears: two years, one open end, backwards swapped, junk ignored', () => {
  assert.deepEqual(readYears('2020', '2024'), { from: 2020, to: 2024 });
  assert.deepEqual(readYears('2024', '2020'), { from: 2020, to: 2024 });
  assert.deepEqual(readYears(undefined, '1989'), { from: undefined, to: 1989 });
  assert.equal(readYears('soon', ''), undefined);
  assert.equal(readYears('99', '30000'), undefined);
});

test('inYears: the first year of the text counts, no window matches everything', () => {
  assert.equal(inYears('2019', { from: 2019, to: 2019 }), true);
  assert.equal(inYears('2011\u20132015', { from: 2012 }), false);   // Cinemeta writes a span with a dash between
  assert.equal(inYears('2019-', { to: 2018 }), false);
  assert.equal(inYears(undefined, { from: 2000 }), false);
  assert.equal(inYears(undefined, undefined), true);
});

test('yearDates: whole years as dates, the end never past today', () => {
  assert.deepEqual(yearDates({ from: 2020, to: 2024 }, '2026-10-13'), { since: '2020-01-01', until: '2024-12-31' });
  assert.deepEqual(yearDates({ from: 2026, to: 2026 }, '2026-10-13'), { since: '2026-01-01', until: '2026-10-13' });
  assert.deepEqual(yearDates({ to: 1989 }, '2026-10-13'), { since: undefined, until: '1989-12-31' });
});
