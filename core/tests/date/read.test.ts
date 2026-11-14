/**
 * @fileoverview readDate: every layout in both orders, and the dates it
 * refuses.
 */

import { describe, expect, test } from 'vite-plus/test';

import { readDate } from '@date';

const MINUTE_MS = 60_000;

/** The minutes since 1970 of a UTC date, as `Date` counts them. */
function at(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / MINUTE_MS;
}

describe('readDate reads each layout the same in either order', () => {
  const cases: Array<[string, number]> = [
    ['2024-03-04', at(2024, 3, 4)],
    ['2024/3/4', at(2024, 3, 4)],
    ['2024.03.04', at(2024, 3, 4)],
    ['13/04/2024', at(2024, 4, 13)],
    ['0000-02-29', at(0, 2, 29)],
    ['1969-12-31', at(1969, 12, 31)],
    ['9999-12-31', at(9999, 12, 31)],
  ];
  for (const [v, minutes] of cases) {
    test(JSON.stringify(v), () => {
      // 13/04/2024 reads only day first.
      if (v !== '13/04/2024') expect(readDate(v, 'month')).toBe(minutes);
      expect(readDate(v, 'day')).toBe(minutes);
    });
  }
});

test('a year-last date reads by the order', () => {
  const cases: Array<[string, number | undefined, number | undefined]> = [
    ['03/04/2024', at(2024, 4, 3), at(2024, 3, 4)],
    ['3-4-2024', at(2024, 4, 3), at(2024, 3, 4)],
    ['13/04/2024', at(2024, 4, 13), undefined],
    ['04/13/2024', undefined, at(2024, 4, 13)],
    ['03/03/2024', at(2024, 3, 3), at(2024, 3, 3)],
  ];
  for (const [v, day, month] of cases) {
    expect(readDate(v, 'day'), v).toBe(day);
    expect(readDate(v, 'month'), v).toBe(month);
  }
});

describe('readDate refuses what is not a date', () => {
  const refused = [
    '',
    '2024',
    '20240304',
    '2024-3',
    '2024/03',
    '2024-00-10',
    '2024-02-30',
    '2023-02-29',
    '1900-02-29',
    '2024-03-00',
    '2024-03-32',
    '2024/03-04',
    '2024-03-004',
    '02024-03-04',
    '24-03-04',
    '03/04/24',
    '03/04/02024',
    '003/04/2024',
    '/03/2024',
    '2024-03-04 12',
    '2024-03-04x',
    'March',
    '-2024-03-04',
    '45355',
  ];
  for (const v of refused) {
    test(JSON.stringify(v), () => {
      expect(readDate(v, 'day')).toBeUndefined();
      expect(readDate(v, 'month')).toBeUndefined();
    });
  }
});
