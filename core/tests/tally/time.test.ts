/**
 * @fileoverview TimeFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { readDate } from '@date';
import { read } from '@ingest';
import { ExactSum, HELD_AT_MOST, TimeFold } from '@tally';
import type { Held } from '@tally';
import { seeded, shuffled } from '@core-tests/lab/cache/stats';
import { REVENUE, ROWS, bytes } from '@core-tests/testdata/sales-q3';

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
    held: 'hour',
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
    const row = (): [string, string] => [
      pick(EDITED_DATES),
      pick(['', 'n/a', `${random()}`, `${-random()}`]),
    ];
    const rows = Array.from({ length: EDITED_ROWS }, row);
    const folded = () => {
      const fold = new TimeFold('month', 'point');
      for (const r of rows) fold.add(...r);
      return fold;
    };
    const fold = folded();
    // As many edits as rows, each a new row in place of an old one.
    for (let edit = 0; edit < EDITED_ROWS; edit++) {
      const r = Math.floor(random() * EDITED_ROWS);
      fold.remove(...rows[r]!);
      rows[r] = row();
      fold.add(...rows[r]);
    }
    expect(fold.read(), `seed ${seed}`).toEqual(folded().read());
  }
});

const DAY_HOURS = 24;
const DAY_MINUTES = DAY_HOURS * HOUR_MINUTES;
/** No month is longer, so each step of it starts a new month. */
const MONTH_MOST_MINUTES = 31 * DAY_MINUTES;
const MINUTE_MS = 60_000;
const YEAR_MONTHS = 12;
const EPOCH_YEAR = 1970;
/** The years readDate reads: 0000 to 9999. */
const YEARS = 10_000;
const PAST_BOUND = HELD_AT_MOST + 1;

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

/** Each period's key and rows, from `minutes` counted again at `held`. */
function counted(minutes: readonly number[], held: Held): number[][] {
  const rows = new Map<number, number>();
  for (const m of minutes) {
    const key = keyOf(m, held);
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  return [...rows].sort(([a], [b]) => a - b);
}

/** A fold of the cells written at `minutes`, in their order. */
function foldOf(minutes: readonly number[]): TimeFold {
  const fold = new TimeFold('day');
  for (const m of minutes) fold.add(written(m));
  return fold;
}

/** `n` minutes from 1970, `step` apart. */
function stepped(n: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => i * step);
}

test('a time fold coarsens past HELD_AT_MOST periods, keeping every count', () => {
  const firstYears = Array.from({ length: YEARS }, (_, year) => {
    const t = new Date(0);
    t.setUTCFullYear(year, 0, 1);
    return t.getTime() / MINUTE_MS;
  });
  const spans: Array<[Held, number[]]> = [
    ['hour', stepped(HELD_AT_MOST, HOUR_MINUTES)],
    ['day', stepped(PAST_BOUND, HOUR_MINUTES)],
    ['month', stepped(PAST_BOUND, DAY_MINUTES)],
    ['year', stepped(PAST_BOUND, MONTH_MOST_MINUTES)],
    ['year', firstYears],
  ];
  for (const [held, minutes] of spans) {
    // Each cell twice, so every period counts more than one row.
    const twice = [...minutes, ...minutes];
    const read = foldOf(twice).read();
    expect(read.held).toBe(held);
    expect(read.periods.map(({ key, rows }) => [key, rows])).toEqual(
      counted(twice, held),
    );
  }
});

// Rows over two years, more hours than a fold holds and fewer days.
const SPAN_MINUTES = 2 * 366 * DAY_MINUTES;
const BLOCK_ROWS = 1_000;
const BLOCKS = 20;

test('a time fold reads the same block by block, in any order', () => {
  for (let seed = 1; seed <= SEEDS / 10; seed++) {
    const random = seeded(seed);
    const minutes = Array.from({ length: BLOCK_ROWS * BLOCKS }, () =>
      Math.floor(random() * SPAN_MINUTES),
    );
    const whole = foldOf(minutes).read();
    expect(whole.held).toBe('day');
    expect(whole.periods.map(({ key, rows }) => [key, rows])).toEqual(
      counted(minutes, 'day'),
    );
    const blocks = [...Array(BLOCKS).keys()];
    const order = shuffled(blocks, random).flatMap((block) =>
      minutes.slice(block * BLOCK_ROWS, (block + 1) * BLOCK_ROWS),
    );
    expect(foldOf(order).read(), `seed ${seed}`).toEqual(whole);
  }
});

test('a fold that coarsened stays coarse once its rows are taken back', () => {
  const minutes = stepped(PAST_BOUND, HOUR_MINUTES);
  const fold = foldOf(minutes);
  for (const m of minutes.slice(1)) fold.remove(written(m));
  expect(fold.read()).toMatchObject({
    held: 'day',
    periods: [{ key: keyOf(minutes[0]!, 'day'), rows: 1 }],
  });
});

test("a time fold sums the sales sheet's revenue per day, exactly", () => {
  const fold = new TimeFold('day', 'point');
  const sums = new Map<number, ExactSum>();
  const revenue = column(REVENUE);
  column(DATE).forEach((v, r) => {
    fold.add(v, revenue[r]);
    const sum = sums.get(hourOf(v)) ?? new ExactSum();
    if (revenue[r] !== '') sum.add(Number(revenue[r]));
    sums.set(hourOf(v), sum);
  });
  const { periods, skipped } = fold.read();
  expect(periods.map(({ key, sum }) => [key, sum])).toEqual(
    [...sums].sort(([a], [b]) => a - b).map(([key, sum]) => [key, sum.value()]),
  );
  expect(skipped).toEqual({ blank: 4, unparsed: 0 });
});

test('a time fold sums cells with their mark, and undated rows apart', () => {
  const fold = new TimeFold('day', 'comma');
  const rows: Array<[string, string]> = [
    ['2024-03-04', '1,5'],
    ['2024-03-04 23:59', '2,25'],
    ['2024-03-04', 'n/a'],
    ['2024-03-05', ''],
    ['', '1.234,56'],
    ['n/a', '0,5'],
  ];
  for (const [date, cell] of rows) fold.add(date, cell);
  expect(fold.read()).toMatchObject({
    periods: [
      { key: hourOf('2024-03-04'), rows: 2, sum: 1.5 },
      { key: hourOf('2024-03-04 23:00'), rows: 1, sum: 2.25 },
      { key: hourOf('2024-03-05'), rows: 1, sum: 0 },
    ],
    undated: { rows: 2, sum: 1235.06 },
    skipped: { blank: 1, unparsed: 1 },
  });
});

const UNIX_SECONDS = 1_700_000_000;
const HOUR_SECONDS = 3_600;

test('a time fold counts the dates it leaves out, and those read the other way', () => {
  const fold = new TimeFold('month');
  const dates = [
    '',
    '',
    'n/a',
    '13/04/2024',
    '13/04/2024 9:05',
    '2024-13-01',
    '04/13/2024',
    '2024-03-04 9:05',
    '2024-03-04 00:00',
    '2024-03-04',
    '2024-03',
  ];
  for (const v of dates) fold.add(v);
  fold.remove('');
  expect(fold.read()).toMatchObject({
    undated: { rows: 5 },
    dates: { blank: 1, unparsed: 4, other: 2 },
    timed: 1,
  });
  // Unix time reads in no other order.
  const unix = new TimeFold('s');
  for (const v of [`${UNIX_SECONDS}`, `${UNIX_SECONDS}000`, '13/04/2024']) {
    unix.add(v);
  }
  expect(unix.read()).toMatchObject({
    periods: [{ key: Math.floor(UNIX_SECONDS / HOUR_SECONDS), rows: 1 }],
    undated: { rows: 2 },
    dates: { blank: 0, unparsed: 2, other: 0 },
    timed: 1,
  });
});
