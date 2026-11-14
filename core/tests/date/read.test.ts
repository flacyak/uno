/**
 * @fileoverview readDate: every layout in both orders, offsets left out, and
 * the times and dates it refuses.
 */

import { describe, expect, test } from 'vite-plus/test';

import { readDate } from '@date';

const MINUTE_MS = 60_000;

/** The minutes since 1970 of a UTC date and time, as `Date` counts them. */
function at(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(hh, mm);
  return t.getTime() / MINUTE_MS;
}

describe('readDate reads each layout the same in either order', () => {
  const cases: Array<[string, number]> = [
    ['2024-03-04', at(2024, 3, 4)],
    ['2024/3/4', at(2024, 3, 4)],
    ['2024.03.04', at(2024, 3, 4)],
    ['2024-03', at(2024, 3, 1)],
    ['2024-03-04 12:30', at(2024, 3, 4, 12, 30)],
    ['2024-03-04T12:30:59', at(2024, 3, 4, 12, 30)],
    ['2024-03-04t12:30:59.999', at(2024, 3, 4, 12, 30)],
    ['2024-03-04T12:30:00Z', at(2024, 3, 4, 12, 30)],
    ['2024-03-04T12:30z', at(2024, 3, 4, 12, 30)],
    ['13/04/2024', at(2024, 4, 13)],
    ['0000-02-29', at(0, 2, 29)],
    ['1969-12-31 23:59', -1],
    ['9999-12-31 23:59', at(9999, 12, 31, 23, 59)],
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
    ['03.04.2024 17:05', at(2024, 4, 3, 17, 5), at(2024, 3, 4, 17, 5)],
    ['13/04/2024', at(2024, 4, 13), undefined],
    ['04/13/2024', undefined, at(2024, 4, 13)],
    ['03/03/2024', at(2024, 3, 3), at(2024, 3, 3)],
  ];
  for (const [v, day, month] of cases) {
    expect(readDate(v, 'day'), v).toBe(day);
    expect(readDate(v, 'month'), v).toBe(month);
  }
});

test('an offset is checked and left out, so a cell counts as written', () => {
  // The same instant, written in two zones, counts on two days.
  expect(readDate('2024-03-04T23:30:00-05:00', 'day')).toBe(
    at(2024, 3, 4, 23, 30),
  );
  expect(readDate('2024-03-05T04:30:00Z', 'day')).toBe(at(2024, 3, 5, 4, 30));
  expect(readDate('2024-03-04 12:30+14:00', 'day')).toBe(
    at(2024, 3, 4, 12, 30),
  );
});

describe('readDate refuses what is not a date', () => {
  const refused = [
    '',
    '2024',
    '20240304',
    '2024-3',
    '2024/03',
    '2024-13',
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
    '2024-03-04 24:00',
    '2024-03-04 23:60',
    '2024-03-04 23:59:60',
    '2024-03-04 1:30',
    '2024-03-04 12:3',
    '2024-03-04 12',
    '2024-03-04 12:30:5',
    '2024-03-04 12:30:00.',
    '2024-03-04 12:30.5',
    '2024-03-04  12:30',
    '2024-03-04_12:30',
    '2024-03-04 12:30+01',
    '2024-03-04 12:30+0100',
    '2024-03-04 12:30+01:0',
    '2024-03-04 12:30 Z',
    '2024-03-04 12:30ZZ',
    '2024-03-04x',
    '2024-03 12:30',
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
