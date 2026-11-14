/**
 * @fileoverview TimeFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { readDate } from '@date';
import { read } from '@ingest';
import { TimeFold } from '@tally';
import { seeded } from '@core-tests/lab/cache/stats';
import { ROWS, bytes } from '@core-tests/testdata/sales-q3';

const DATE = 0;
const HOUR_MINUTES = 60;
// Enough seeds that edits empty and start periods dozens of times.
const SEEDS = 50;
// Few enough rows per hour that edits empty some periods and start others.
const EDITED_ROWS = 16;
const EDITED_DATES = [
  '',
  'n/a',
  '2024-03-04 09:05',
  '04/03/2024 9:59',
  '2024-03-04T10:00:00Z',
  '2024-03-05',
  '13/04/2024 23:00',
];

/** The key of the hour `v` writes, read day first. */
function hourOf(v: string): number {
  return Math.floor(readDate(v, 'day')! / HOUR_MINUTES);
}

/** The sales sheet's column `col`, as the engine shows it. */
function column(col: number): string[] {
  const sheet = read('sales-q3.csv', bytes);
  return Array.from({ length: sheet.rows() }, (_, r) => sheet.display(r, col));
}

test('a time fold counts the rows of each hour, earliest first', () => {
  const fold = new TimeFold('day');
  const dates = [
    '2024-03-04 14:05',
    '04/03/2024 14:59:59',
    '2024-03-04T09:00Z',
    '2024-03-04',
    'n/a',
    '',
  ];
  for (const v of dates) fold.add(v);
  expect(fold.read()).toMatchObject({
    periods: [
      { key: hourOf('2024-03-04'), rows: 1 },
      { key: hourOf('2024-03-04 09:00'), rows: 1 },
      { key: hourOf('2024-03-04 14:00'), rows: 2 },
    ],
    undated: { rows: 2 },
  });
});

test('a time fold counts the sales sheet per day', () => {
  const fold = new TimeFold('day');
  const days = new Map<number, number>();
  for (const v of column(DATE)) {
    fold.add(v);
    days.set(hourOf(v), (days.get(hourOf(v)) ?? 0) + 1);
  }
  const { periods, undated } = fold.read();
  expect(periods.map(({ key, rows }) => [key, rows])).toEqual(
    [...days].sort(([a], [b]) => a - b),
  );
  expect(undated.rows).toBe(0);
  expect(periods.reduce((all, p) => all + p.rows, 0)).toBe(ROWS);
});

test('a time fold moved by edits reads as one that counts again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const rows = Array.from({ length: EDITED_ROWS }, () => pick(EDITED_DATES));
    const folded = () => {
      const fold = new TimeFold('month');
      for (const date of rows) fold.add(date);
      return fold;
    };
    const fold = folded();
    // As many edits as rows, each a new row in place of an old one.
    for (let edit = 0; edit < EDITED_ROWS; edit++) {
      const r = Math.floor(random() * EDITED_ROWS);
      fold.remove(rows[r]!);
      rows[r] = pick(EDITED_DATES);
      fold.add(rows[r]);
    }
    expect(fold.read(), `seed ${seed}`).toEqual(folded().read());
  }
});
