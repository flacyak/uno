/**
 * @fileoverview TimeFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { readDate } from '@date';
import { read } from '@ingest';
import {
  ExactSum,
  HELD_AT_MOST,
  LEVEL_BATCH,
  TimeFold,
  sundayOf,
} from '@tally';
import type { Held, Per } from '@tally';
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
const YEAR_QUARTERS = 4;
const WEEK_DAYS = 7;
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

/** The key of the day `v` writes, read day first. */
function dayOf(v: string): number {
  return Math.floor(readDate(v, 'day')! / DAY_MINUTES);
}

/** A fold of `dates`, with `cells` summed where given. */
function snapped(
  dates: readonly string[],
  cells?: readonly string[],
): TimeFold {
  const fold =
    cells === undefined ? new TimeFold('day') : new TimeFold('day', 'point');
  dates.forEach((v, r) => fold.add(v, cells?.[r]));
  return fold;
}

/** Each level a snapshot at `per` sends: its size, first key and rows. */
function levels(
  fold: TimeFold,
  per: Per | 'auto',
): Array<[Per, number, number]> {
  return fold.snapshot(per).levels.map((l) => [l.per, l.from, l.rows.length]);
}

test('a snapshot sends each level from its size to years, dense with zeros', () => {
  const dates = ['2024-03-01', '2024-03-03', '2024-05-10', 'n/a'];
  const fold = snapped(dates, ['1', '2', '4', '8']);
  const { levels: sent, undated } = fold.snapshot('day');
  const march = dayOf('2024-03-01');
  // March, April, and 1 to 10 May.
  const days = 31 + 30 + 10;
  expect(sent.map((l) => l.per)).toEqual([
    'day',
    'week',
    'month',
    'quarter',
    'year',
  ]);
  expect(sent[0]).toMatchObject({ per: 'day', from: march });
  expect(sent[0]!.rows).toEqual([1, 0, 1, ...Array(days - 4).fill(0), 1]);
  expect(sent[0]!.sum.filter((s) => s !== 0)).toEqual([1, 2, 4]);
  expect(sent[2]).toMatchObject({ rows: [2, 0, 1], sum: [3, 0, 4] });
  expect(sent[3]).toMatchObject({ rows: [2, 1], sum: [3, 4] });
  expect(sent[4]).toMatchObject({
    from: 2024 - EPOCH_YEAR,
    rows: [3],
    sum: [7],
  });
  expect(undated).toEqual({ rows: 1, sum: 8 });
  // A fold that counts rows sends no sums.
  expect(snapped(dates).snapshot('year').levels).toEqual([
    {
      per: 'year',
      from: 2024 - EPOCH_YEAR,
      span: 1,
      offset: 0,
      rows: [3],
      sum: [],
    },
  ]);
  expect(snapped([]).snapshot('auto').levels).toEqual([]);
});

test('weeks start on Sunday and are labelled by it, across a new year', () => {
  const dates = ['2022-12-31', '2023-01-01', '2023-01-07', '2023-01-08'];
  const [week] = snapped(dates).snapshot('week').levels;
  expect(week!.rows).toEqual([1, 2, 1]);
  const sunday = new Date(sundayOf(week!.from) * DAY_MINUTES * MINUTE_MS);
  expect(sunday.toISOString().slice(0, 10)).toBe('2022-12-25');
  // The Sunday of a week before 1970, and of week 0.
  expect(sundayOf(0)).toBe(dayOf('1969-12-28'));
  expect(sundayOf(-1)).toBe(dayOf('1969-12-21'));
});

/** Each level a snapshot at `per` sends: its size, span and batch's rows. */
function spans(fold: TimeFold, per: Per): Array<[Per, number, number]> {
  return fold.snapshot(per).levels.map((l) => [l.per, l.span, l.rows.length]);
}

test('a snapshot sends the first LEVEL_BATCH periods of every level', () => {
  const span = snapped(['1900-01-01', '2024-12-31']);
  const years = 2024 - 1900 + 1;
  const days = dayOf('2024-12-31') - dayOf('1900-01-01') + 1;
  // 1900-01-01 was a Monday and 2024-12-31 a Tuesday, so the weeks run from
  // Sunday 31 December 1899 to Sunday 29 December 2024.
  const sundays = dayOf('2024-12-29') - dayOf('1899-12-31');
  const weeks = sundays / WEEK_DAYS + 1;
  expect(spans(span, 'day')).toEqual([
    ['day', days, LEVEL_BATCH],
    ['week', weeks, LEVEL_BATCH],
    ['month', years * YEAR_MONTHS, LEVEL_BATCH],
    ['quarter', years * YEAR_QUARTERS, years * YEAR_QUARTERS],
    ['year', years, years],
  ]);
  const most = (LEVEL_BATCH - 1) * DAY_MINUTES;
  expect(spans(foldOf([0, most]), 'day')[0]).toEqual([
    'day',
    LEVEL_BATCH,
    LEVEL_BATCH,
  ]);
  const past = foldOf([0, most + DAY_MINUTES]);
  expect(spans(past, 'day')[0]).toEqual(['day', LEVEL_BATCH + 1, LEVEL_BATCH]);
  expect(past.batch('day', LEVEL_BATCH)).toMatchObject({ from: 0, rows: [1] });
});

test('a batch starts at any place in its size, and none past it', () => {
  const fold = snapped(['2024-03-01', '2024-03-03', '2024-03-04']);
  const march = dayOf('2024-03-01');
  expect(fold.batch('day', 2)).toMatchObject({
    from: march,
    span: 4,
    offset: 2,
    rows: [1, 1],
  });
  for (const offset of [-1, 4, 1.5, Number.NaN]) {
    expect(fold.batch('day', offset), `${offset}`).toBeUndefined();
  }
  expect(snapped([]).batch('day', 0)).toBeUndefined();
  const months = foldOf(stepped(PAST_BOUND, DAY_MINUTES));
  expect(months.batch('day', 0)).toBeUndefined();
  expect(months.batch('month', 0)?.per).toBe('month');
});

test('a 125-year monthly fold sends every month across batches', () => {
  const months: string[] = [];
  for (let year = 1900; year <= 2024; year++) {
    for (let month = 1; month <= YEAR_MONTHS; month++) {
      months.push(`${year}-${String(month).padStart(2, '0')}-01`);
    }
  }
  const fold = snapped(
    months,
    months.map((_, i) => `${i}`),
  );
  const first = fold.snapshot('month').levels[0]!;
  expect(first).toMatchObject({
    per: 'month',
    from: (1900 - EPOCH_YEAR) * YEAR_MONTHS,
    span: months.length,
    offset: 0,
  });
  const batches = [first];
  for (let at = LEVEL_BATCH; at < first.span; at += LEVEL_BATCH) {
    batches.push(fold.batch('month', at)!);
  }
  expect(batches.map((b) => [b.from, b.span, b.offset, b.rows.length])).toEqual(
    [
      [first.from, months.length, 0, LEVEL_BATCH],
      [first.from, months.length, LEVEL_BATCH, months.length - LEVEL_BATCH],
    ],
  );
  expect(batches.flatMap((b) => b.rows)).toEqual(months.map(() => 1));
  expect(batches.flatMap((b) => b.sum)).toEqual(months.map((_, i) => i));
});

test('a snapshot starts at the size asked for, or the finest the fold can make', () => {
  const dates = snapped(['2024-03-04', '2024-03-05']);
  const timed = snapped(['2024-03-04', '2024-03-05 9:05']);
  expect(levels(dates, 'auto')[0]![0]).toBe('day');
  expect(levels(timed, 'auto')[0]![0]).toBe('hour');
  expect(levels(dates, 'hour')[0]![0]).toBe('hour');
  expect(levels(dates, 'month')[0]![0]).toBe('month');
  // A fold that holds days makes no hours, and one that holds months no days
  // or weeks.
  const days = foldOf(stepped(PAST_BOUND, HOUR_MINUTES));
  expect(levels(days, 'hour')[0]![0]).toBe('day');
  const months = foldOf(stepped(PAST_BOUND, DAY_MINUTES));
  expect(months.snapshot('day').levels.map((l) => l.per)).toEqual([
    'month',
    'quarter',
    'year',
  ]);
});

test("a Unix column's periods are UTC", () => {
  const fold = new TimeFold('s');
  fold.add(`${UNIX_SECONDS}`);
  const [hour, day] = fold.snapshot('hour').levels;
  expect(hour!.from).toBe(Math.floor(UNIX_SECONDS / HOUR_SECONDS));
  expect(day!.from).toBe(
    dayOf(new Date(UNIX_SECONDS * 1000).toISOString().slice(0, 10)),
  );
});
