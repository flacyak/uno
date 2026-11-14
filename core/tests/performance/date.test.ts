/**
 * @fileoverview Times isDate against the regular expressions it replaced,
 * kept below as they were, over the layouts in digits. A chart reads every
 * cell of its date column, so readDate is held to at least DATE_SPEEDUP times
 * as fast. Both run in the same process, so a busy machine slows both alike.
 */

import { afterAll, expect, test } from 'vite-plus/test';

import { isDate } from '@sheet';
import { record } from '@core-tests/efficiency/record';
import type { Metric } from '@core-tests/efficiency/record';

/** How many times as fast as the regular expressions isDate must be. */
const DATE_SPEEDUP = 3;
/** Cells read per timed run, cycling through a layout's four. */
const CELLS = 400_000;
const SAMPLES = 7;

/** Four cells of each layout, real dates that every reader accepts. */
const LAYOUTS: Record<string, readonly string[]> = {
  'year first': ['2024-03-04', '2023-11-30', '2019/07/15', '2020.02.29'],
  'year last': ['04/03/2024', '30/11/2023', '7-15-2019', '29.02.2020'],
  'RFC 3339': [
    '2024-03-04T14:05:09+01:00',
    '2023-11-30T00:00:00Z',
    '2019-07-15T23:59:59-05:00',
    '2020-02-29T12:00:00.5Z',
  ],
};

const metrics: Metric[] = [];
afterAll(() => record('date', metrics, 'performance'));

/** The quickest of SAMPLES runs of `read` over CELLS cells, in ms. */
function quickest(
  read: (v: string) => boolean,
  cells: readonly string[],
): number {
  let best = Infinity;
  let dates = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const started = performance.now();
    for (let i = 0; i < CELLS; i++) if (read(cells[i % cells.length]!)) dates++;
    best = Math.min(best, performance.now() - started);
  }
  expect(dates).toBe(SAMPLES * CELLS);
  return best;
}

for (const [layout, cells] of Object.entries(LAYOUTS)) {
  test(`isDate reads ${layout} at least ${DATE_SPEEDUP} times as fast`, () => {
    const before = quickest(mainIsDate, cells);
    const after = quickest(isDate, cells);
    metrics.push(
      {
        name: `isDate, ${layout}, 400,000 cells: ms`,
        unit: 'ms',
        value: after,
      },
      {
        name: `isDate, ${layout}, against main's: x`,
        unit: 'x',
        value: after / before,
      },
    );
    expect(before / after).toBeGreaterThanOrEqual(DATE_SPEEDUP);
  });
}

// isDate as it was before readDate: kind.ts at 700cfe89b, as written there.

// The layouts a date can be written in: year first with one separator, year
// last the same way, a month by name, and RFC 3339. These are matched by
// hand because `new Date` accepts far more.
const YEAR_FIRST = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/;
// Nov. 6, 1970 and November 6 1970; 6 Nov 1970 and 06-Nov-1970.
const NAME_FIRST = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/;
const DAY_FIRST = /^(\d{1,2})([ -])([A-Za-z]+)\.?\2(\d{4})$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// A month is its full name or its three-letter form, plus "sept".
const MONTHS = new Map<string, number>();
[
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
].forEach((name, i) => {
  MONTHS.set(name, i + 1);
  MONTHS.set(name.slice(0, 3), i + 1);
});
MONTHS.set('sept', 9);

function month(name: string): number {
  return MONTHS.get(name.toLowerCase()) ?? 0;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the next month is the last day of this one.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function mainIsDate(v: string): boolean {
  for (const [shape, real] of DATE_SHAPES) {
    const m = shape.exec(v);
    if (m !== null) return real(m);
  }
  return false;
}

/** Each date layout, with a check that its fields make a real date. */
const DATE_SHAPES: ReadonlyArray<[RegExp, (m: RegExpExecArray) => boolean]> = [
  [YEAR_FIRST, (m) => isRealDate(Number(m[1]), Number(m[3]), Number(m[4]))],
  // 20-11-2024 is day first and 11/20/2024 is month first. Either reading
  // counts.
  [
    YEAR_LAST,
    (m) =>
      isRealDate(Number(m[4]), Number(m[3]), Number(m[1])) ||
      isRealDate(Number(m[4]), Number(m[1]), Number(m[3])),
  ],
  [NAME_FIRST, (m) => isRealDate(Number(m[3]), month(m[1]!), Number(m[2]))],
  [DAY_FIRST, (m) => isRealDate(Number(m[4]), month(m[3]!), Number(m[1]))],
  [
    RFC3339,
    (m) =>
      isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) &&
      // Seconds stop at 59, so a leap second reads as text.
      Number(m[4]) <= 23 &&
      Number(m[5]) <= 59 &&
      Number(m[6]) <= 59,
  ],
];
