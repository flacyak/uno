/**
 * @fileoverview The calendar in integers: every day from 0000 to 9999 against
 * `Date`, whose setUTCFullYear reads the years 0 to 99 as written.
 */

import { expect, test } from 'vite-plus/test';

import { civilFromDays, daysFromCivil, isLeap, monthDays } from '@date';

const DAY_MS = 86_400_000;

/** The date `days` after 1970-01-01, as `Date` counts it. */
function oracle(days: number): [number, number, number] {
  const d = new Date(days * DAY_MS);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

test('every day from 0000-01-01 to 9999-12-31 goes there and back', () => {
  const first = daysFromCivil(0, 1, 1);
  const last = daysFromCivil(9999, 12, 31);
  const start = new Date(0);
  start.setUTCFullYear(0, 0, 1);
  expect(first * DAY_MS).toBe(start.getTime());
  let wrong = 0;
  for (let days = first; days <= last; days++) {
    const { year, month, day } = civilFromDays(days);
    const [y, m, d] = oracle(days);
    if (year !== y || month !== m || day !== d) wrong++;
    else if (daysFromCivil(year, month, day) !== days) wrong++;
  }
  expect(wrong).toBe(0);
});

test('the epoch is day 0', () => {
  expect(daysFromCivil(1970, 1, 1)).toBe(0);
  expect(civilFromDays(-1)).toEqual({ year: 1969, month: 12, day: 31 });
});

test('leap years follow the proleptic Gregorian rule, year 0 included', () => {
  const cases: Array<[number, boolean]> = [
    [0, true],
    [4, true],
    [100, false],
    [400, true],
    [1900, false],
    [2000, true],
    [2023, false],
    [2024, true],
  ];
  for (const [year, leap] of cases) {
    expect(isLeap(year), String(year)).toBe(leap);
    expect(monthDays(year, 2), String(year)).toBe(leap ? 29 : 28);
  }
});
