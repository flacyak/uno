/**
 * @fileoverview TimeSplitFold against its rows counted again from scratch,
 * per value and hour.
 */

import { expect, test } from 'vite-plus/test';

import { readDate } from '@date';
import { TimeSplitFold } from '@tally';
import type { TimeSplits } from '@tally';
import { seeded } from '@core-tests/lab/cache/stats';

const HOUR_MINUTES = 60;
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
  const hour = (date: string) =>
    Math.floor(readDate(date, 'day')! / HOUR_MINUTES);
  expect(read.values).toStrictEqual([
    {
      value: 'North',
      periods: [{ key: hour('2024-03-04 14:00'), rows: 2, sum: -0.5 }],
      undated: { rows: 0, sum: 0 },
    },
    {
      value: 'South',
      periods: [{ key: hour('2024-03-04 09:00'), rows: 1, sum: 0 }],
      undated: { rows: 1, sum: 0.25 },
    },
  ]);
  expect(read.dates).toStrictEqual({ blank: 1, unparsed: 0, other: 0 });
  expect(read.skipped).toStrictEqual({ blank: 0, unparsed: 1 });
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
