/**
 * @fileoverview WeekFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { END_MINUTE, FIRST_MINUTE } from '@date';
import { DAY_HOURS, WEEK_HOURS, WeekFold } from '@tally';
import { seeded } from '@core-tests/lab/cache/stats';

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const SEEDS = 50;
const DRAWS = 2_000;
// Few enough rows that edits empty some hours and start others.
const EDITED_ROWS = 16;
const EDITED_DATES = [
  '',
  'n/a',
  '2024-03-03 00:30',
  '03/03/2024 23:59',
  '2024-03-05T14:00:00Z',
  '2024-03-09',
  '13/04/2024 23:00',
];

/** A date and time `minute` minutes after 1970, as a cell writes it. */
function written(minute: number): string {
  const iso = new Date(minute * MINUTE_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** The hour of the week `minute` falls in, Sunday first, as Date counts it. */
function hourOfWeek(minute: number): number {
  const at = new Date(minute * MINUTE_MS);
  return at.getUTCDay() * DAY_HOURS + at.getUTCHours();
}

/** Each hour's rows of a snapshot. */
const rowsOf = (fold: WeekFold) => fold.snapshot().hours.map((h) => h.rows);

test('a week fold counts the rows of each hour of the week, Sunday first', () => {
  const fold = new WeekFold('day');
  const dates = [
    '2024-03-03 00:30',
    '2024-03-09 23:59',
    '05/03/2024 14:05',
    '2024-03-05T14:59Z',
    '1969-12-28 05:00',
    '2024-03-06',
    'n/a',
    '',
    '13/13/2024',
  ];
  for (const v of dates) fold.add(v);
  const week = fold.snapshot();
  expect(week.hours).toHaveLength(WEEK_HOURS);
  const rows = new Map(
    week.hours.flatMap((h, i) => (h.rows > 0 ? [[i, h.rows]] : [])),
  );
  // Sunday 00:00, Sunday 05:00 before 1970, Tuesday 14:00 twice, Wednesday's
  // midnight, Saturday 23:00.
  expect([...rows]).toEqual([
    [0, 1],
    [5, 1],
    [62, 2],
    [72, 1],
    [167, 1],
  ]);
  expect(week.undated.rows).toBe(3);
  expect(week.dates).toEqual({ blank: 1, unparsed: 2, other: 0 });
});

test('a week fold counts dates over every year it reads as Date does', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const span = END_MINUTE - FIRST_MINUTE;
    const minutes = Array.from({ length: DRAWS }, () =>
      Math.floor(FIRST_MINUTE + random() * span),
    );
    const fold = new WeekFold('month');
    const want = Array.from({ length: WEEK_HOURS }, () => 0);
    for (const m of minutes) {
      fold.add(written(m));
      want[hourOfWeek(m)]!++;
    }
    expect(rowsOf(fold), `seed ${seed}`).toEqual(want);
  }
});

test('a week fold moved by edits reads as one that counts again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const row = (): string => pick(EDITED_DATES);
    const rows = Array.from({ length: EDITED_ROWS }, row);
    const folded = () => {
      const fold = new WeekFold('day');
      for (const r of rows) fold.add(r);
      return fold;
    };
    const fold = folded();
    for (let edit = 0; edit < EDITED_ROWS; edit++) {
      const r = Math.floor(random() * EDITED_ROWS);
      fold.remove(rows[r]!);
      rows[r] = row();
      fold.add(rows[r]);
    }
    expect(fold.snapshot(), `seed ${seed}`).toEqual(folded().snapshot());
  }
});

test('a Unix column reads its hours of the week in UTC', () => {
  const fold = new WeekFold('s');
  // 2024-03-05 14:00 UTC, a Tuesday.
  const tuesday = Date.UTC(2024, 2, 5, 14) / MINUTE_MS / HOUR_MINUTES;
  fold.add(`${tuesday * HOUR_MINUTES * HOUR_MINUTES}`);
  expect(rowsOf(fold).indexOf(1)).toBe(2 * DAY_HOURS + 14);
});
