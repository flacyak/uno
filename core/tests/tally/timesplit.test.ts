/**
 * @fileoverview TimeSplitFold against its rows counted again from scratch:
 * per value and period, every value at one period, coarsened together.
 */

import { expect, test } from 'vite-plus/test';

import { readDate } from '@date';
import {
  DISTINCT_AT_MOST,
  PAIRS_AT_MOST,
  SPLIT_VALUES_SENT,
  TimeSplitFold,
} from '@tally';
import type { Held, TimeSplits } from '@tally';
import { seeded, shuffled } from '@core-tests/lab/cache/stats';

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const EPOCH_YEAR = 1970;
const YEAR_MONTHS = 12;
const SEEDS = 50;
const EDITED_ROWS = 16;
const REGIONS = ['North', 'South', 'East', ''];
const DATES = [
  '',
  'n/a',
  '2024-03-04 09:05',
  '04/03/2024 9:59',
  '2024-03-05',
  '13/04/2024 23:00',
];
const CELLS = ['', 'n/a', '1.5', '-2', '0.25'];

/** A date and time `minute` minutes after 1970, as a cell writes it. */
function written(minute: number): string {
  const iso = new Date(minute * MINUTE_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** The key of the period at `held` that `minute` falls in, as Date counts. */
function keyOf(minute: number, held: Held): number {
  const at = new Date(minute * MINUTE_MS);
  const months =
    (at.getUTCFullYear() - EPOCH_YEAR) * YEAR_MONTHS + at.getUTCMonth();
  const keys: Record<Held, number> = {
    hour: Math.floor(minute / HOUR_MINUTES),
    day: Math.floor(minute / DAY_MINUTES),
    month: months,
    year: Math.floor(months / YEAR_MONTHS),
  };
  return keys[held];
}

/** Each value's periods' keys and rows, counted again at `held` from rows of a value and a date read day first. */
function counted(
  rows: ReadonlyArray<readonly [string, string]>,
  held: Held,
): Record<string, number[][]> {
  const byValue: Record<string, Map<number, number>> = {};
  for (const [value, date] of rows) {
    const minute = readDate(date, 'day');
    if (minute === undefined) continue;
    const periods = (byValue[value] ??= new Map());
    const key = keyOf(minute, held);
    periods.set(key, (periods.get(key) ?? 0) + 1);
  }
  const sorted = Object.entries(byValue).map(([v, m]) => [
    v,
    [...m].sort(([a], [b]) => a - b),
  ]);
  return Object.fromEntries(sorted);
}

/** What `fold` holds of each value, its periods' keys and rows, by value. */
function heldOf(read: TimeSplits): Record<string, number[][]> {
  const entries = read.values
    .filter((v) => v.periods.length > 0)
    .map((v) => [v.value, v.periods.map((p) => [p.key, p.rows])]);
  return Object.fromEntries(entries);
}

/** A fold's read with its values in value order, so folds that began them in other orders compare. */
function ordered(read: TimeSplits): TimeSplits {
  return {
    ...read,
    values: [...read.values].sort((a, b) => (a.value < b.value ? -1 : 1)),
  };
}

test('a time split fold counts each value per hour, its undated rows, and sums its cells', () => {
  const fold = new TimeSplitFold('day', 'point');
  fold.add('North', '2024-03-04 14:05', '1.5');
  fold.add('North', '04/03/2024 14:59', '-2');
  fold.add('South', '2024-03-04 09:00', 'n/a');
  fold.add('South', '', '0.25');
  const read = fold.read();
  expect(read.held).toBe('hour');
  const hour = (date: string) =>
    Math.floor(readDate(date, 'day')! / HOUR_MINUTES);
  expect(read.values).toStrictEqual([
    {
      value: 'North',
      periods: [{ key: hour('2024-03-04 14:00'), rows: 2, sum: -0.5 }],
      undated: { rows: 0, sum: 0 },
      unsplit: { rows: 0, sum: 0 },
    },
    {
      value: 'South',
      periods: [{ key: hour('2024-03-04 09:00'), rows: 1, sum: 0 }],
      undated: { rows: 1, sum: 0.25 },
      unsplit: { rows: 0, sum: 0 },
    },
  ]);
  expect(read.dates).toStrictEqual({ blank: 1, unparsed: 0, other: 0 });
  expect(read.skipped).toStrictEqual({ blank: 0, unparsed: 1 });
});

test('every value coarsens together past PAIRS_AT_MOST cells, keeping every count, in any block order', () => {
  // Hours of four values, a day apart, more cells than the bound.
  const rows = Array.from(
    { length: PAIRS_AT_MOST + 1 },
    (_, i) =>
      [REGIONS[i % REGIONS.length]!, written(i * HOUR_MINUTES)] as const,
  );
  const fold = new TimeSplitFold('day');
  for (const [value, date] of rows) fold.add(value, date);
  const read = fold.read();
  expect(read.held).toBe('day');
  expect(heldOf(read)).toStrictEqual(counted(rows, 'day'));
  const again = new TimeSplitFold('day');
  for (const [value, date] of shuffled(rows, seeded(1))) again.add(value, date);
  expect(ordered(again.read())).toStrictEqual(ordered(read));
});

test('a time split fold moved by edits reads as one that counts again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(random() * xs.length)]!;
    const row = (): [string, string, string] => [
      pick(REGIONS),
      pick(DATES),
      pick(CELLS),
    ];
    const rows = Array.from({ length: EDITED_ROWS }, row);
    const folded = () => {
      const fold = new TimeSplitFold('day', 'point');
      for (const r of rows) fold.add(...r);
      return fold;
    };
    const fold = folded();
    for (let edit = 0; edit < EDITED_ROWS; edit++) {
      const r = Math.floor(random() * EDITED_ROWS);
      fold.remove(...rows[r]!);
      rows[r] = row();
      fold.add(...rows[r]);
    }
    expect(ordered(fold.read()), `seed ${seed}`).toStrictEqual(
      ordered(folded().read()),
    );
  }
});

test('values past DISTINCT_AT_MOST count in the rest', () => {
  const fold = new TimeSplitFold('day', 'point');
  for (let v = 0; v <= DISTINCT_AT_MOST; v++)
    fold.add(`v${v}`, '2024-03-04', '1');
  const read = fold.read();
  expect(read.values).toHaveLength(DISTINCT_AT_MOST);
  expect(read.rest).toStrictEqual({ rows: 1, sum: 1 });
});

test('past years, a cell that would pass the bound counts in its value unsplit, so every row is counted once', () => {
  // Three values each with a row in every year of 0001 to 9999: past the bound at years.
  const years = 9_999;
  const fold = new TimeSplitFold('day');
  const values = ['a', 'b', 'c'];
  for (const value of values) {
    for (let y = 1; y <= years; y++)
      fold.add(value, `${String(y).padStart(4, '0')}-06-01`);
  }
  const read = fold.read();
  expect(read.held).toBe('year');
  const cells = read.values.reduce((n, v) => n + v.periods.length, 0);
  // The cell that passed the bound at months stays as its year.
  expect(cells).toBe(PAIRS_AT_MOST + 1);
  expect(read.values.some((v) => v.unsplit.rows > 0)).toBe(true);
  const rows = read.values.reduce(
    (n, v) => n + v.unsplit.rows + v.periods.reduce((m, p) => m + p.rows, 0),
    0,
  );
  expect(rows).toBe(values.length * years);
});

test('the values a chart draws are those of most rows, or the largest sum, and the rest are counted apart', () => {
  const fold = new TimeSplitFold('day', 'point');
  // Value v has v + 1 rows, each worth 1.
  const count = SPLIT_VALUES_SENT + 2;
  const name = (v: number) => `v${String(v).padStart(2, '0')}`;
  for (let v = 0; v < count; v++) {
    for (let r = 0; r <= v; r++) fold.add(name(v), '2024-03-04', '1');
  }
  fold.add(name(0), '', '0.5');
  const { values, others } = fold.ranked();
  expect(values.map((v) => v.value)).toStrictEqual(
    Array.from({ length: SPLIT_VALUES_SENT }, (_, i) => name(count - 1 - i)),
  );
  expect(values[0]).toStrictEqual({
    value: name(count - 1),
    rows: count,
    sum: count,
    undated: { rows: 0, sum: 0 },
    unsplit: { rows: 0, sum: 0 },
  });
  // v01's 2 rows, and v00's 1 and its undated 0.5.
  expect(others).toStrictEqual({ values: 2, rows: 4, sum: 3.5 });
  // One row of 100 against three of 1: first by its sum, last by its rows.
  const summing = new TimeSplitFold('day', 'point');
  const counting = new TimeSplitFold('day');
  for (const [v, cell] of [
    ['a', '100'],
    ['b', '1'],
    ['b', '1'],
    ['b', '1'],
  ] as const) {
    summing.add(v, '2024-03-04', cell);
    counting.add(v, '2024-03-04', cell);
  }
  expect(summing.ranked().values.map((v) => v.value)).toStrictEqual(['a', 'b']);
  expect(counting.ranked().values.map((v) => v.value)).toStrictEqual([
    'b',
    'a',
  ]);
});
