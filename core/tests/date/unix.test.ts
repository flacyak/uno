/**
 * @fileoverview Unix seconds and milliseconds: which samples inferUnit names,
 * and how readDate reads a whole number in each unit, in UTC.
 */

import { expect, test } from 'vite-plus/test';

import { inferUnit, readDate } from '@date';

const MINUTE_MS = 60_000;

/** The minute a Unix time in milliseconds falls in, as `Date` counts it. */
function minuteOf(ms: number): number {
  return Math.floor(new Date(ms).getTime() / MINUTE_MS);
}

test('a sample of whole numbers in range names its unit', () => {
  const cases: Array<[string, string[], string | undefined]> = [
    ['seconds', ['1700000000', '1000000000', ' 9999999999 '], 's'],
    ['milliseconds', ['1700000000123', '1000000000000'], 'ms'],
    ['seconds beside milliseconds', ['1700000000', '1700000000123'], undefined],
    ['before 2001-09-09', ['999999999', '1700000000'], undefined],
    ['eleven digits', ['17000000000'], undefined],
    ['a fraction', ['1700000000.5'], undefined],
    ['a sign', ['+1700000000'], undefined],
    ['an Excel serial day', ['45355', '45356'], undefined],
    ['grouped', ['1,700,000,000'], undefined],
    ['empty', [], undefined],
  ];
  for (const [name, values, unit] of cases) {
    expect(inferUnit(values), name).toBe(unit);
  }
});

test('readDate reads a whole number of Unix time in its unit', () => {
  const at = minuteOf(1_700_000_000_123);
  expect(readDate('1700000000', 's')).toBe(at);
  expect(readDate(' 1700000000123 ', 'ms')).toBe(at);
  expect(readDate('0', 's')).toBe(0);
  expect(readDate('59', 's')).toBe(0);
  expect(readDate('60', 's')).toBe(1);
  expect(readDate('253402300799', 's')).toBe(minuteOf(253_402_300_799_000));
});

test('readDate refuses what is not a whole number of Unix time', () => {
  const refused: Array<[string, 's' | 'ms']> = [
    ['', 's'],
    ['-1', 's'],
    ['1700000000.5', 's'],
    ['1,700,000,000', 's'],
    ['2024-03-04', 's'],
    ['1700000000 s', 's'],
    // 10000-01-01, past the years readDate reads.
    ['253402300800', 's'],
    ['253402300800000', 'ms'],
  ];
  for (const [v, unit] of refused) expect(readDate(v, unit), v).toBeUndefined();
  // A number is never a date by an order.
  expect(readDate('1700000000', 'day')).toBeUndefined();
  expect(readDate('45355', 'month')).toBeUndefined();
});
