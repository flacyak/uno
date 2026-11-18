/**
 * @fileoverview SplitFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { compareStrings } from '@go';
import { GROUPS_SENT } from '@tally/groups';
import { SERIES_AT_MOST, SplitFold } from '@tally/split';
import type { Split } from '@tally/split';
import { seeded } from '@core-tests/lab/cache/stats';

// Enough seeds that edits empty and start cells dozens of times.
const SEEDS = 50;
// Few enough rows per pair that edits empty some cells and start others.
const ROWS = 40;
const VALUES = ['', 'East', 'North', 'South', 'West'];
// More series than a snapshot sends, so some are always Other.
const SERIES = [
  '',
  'web',
  'direct',
  'partner',
  'mail',
  'phone',
  'shop',
  'fair',
];

type Row = [value: string, series: string];

function folded(rows: Row[]): SplitFold {
  const fold = new SplitFold();
  for (const [value, series] of rows) fold.add(value, series);
  return fold;
}

/** counted is what a fold of `rows` that passes no bound reads as. */
function counted(rows: Row[]): Split {
  const pairs = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const [value, series] of rows) {
    const cells = pairs.get(value) ?? new Map<string, number>();
    cells.set(series, (cells.get(series) ?? 0) + 1);
    pairs.set(value, cells);
    totals.set(series, (totals.get(series) ?? 0) + 1);
  }
  const series = [...totals]
    .sort(([a, x], [b, y]) => y - x || compareStrings(a, b))
    .slice(0, SERIES_AT_MOST)
    .map(([name]) => name);
  const values = [...pairs]
    .map(([value, cells]) => {
      const rows = [...cells.values()].reduce((a, b) => a + b, 0);
      const shown = series.map((s) => ({ rows: cells.get(s) ?? 0 }));
      const drawn = shown.reduce((a, b) => a + b.rows, 0);
      return {
        value,
        cells: shown,
        other: { rows: rows - drawn },
        total: { rows },
      };
    })
    .sort(
      (a, b) => b.total.rows - a.total.rows || compareStrings(a.value, b.value),
    );
  return {
    series,
    values,
    others: { values: 0, rows: 0 },
  };
}

test('a split fold moved by edits reads as its rows counted again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const row = (): Row => [pick(VALUES), pick(SERIES)];
    const rows = Array.from({ length: ROWS }, row);
    const fold = folded(rows);
    expect(fold.snapshot(), `seed ${seed}`).toEqual(counted(rows));
    // As many edits as rows, each a new row in place of an old one.
    for (let edit = 0; edit < ROWS; edit++) {
      const r = Math.floor(random() * ROWS);
      fold.remove(...rows[r]!);
      rows[r] = row();
      fold.add(...rows[r]);
    }
    expect(fold.snapshot(), `seed ${seed}, edited`).toEqual(counted(rows));
  }
});

test('a snapshot sends the largest values, and the rest as one', () => {
  const unsent = 3;
  const rows: Row[] = [];
  // Value 0 has the most rows, and the rest tie, so go in value order.
  for (let i = 0; i < GROUPS_SENT + unsent; i++) rows.push([`${i}`, 'web']);
  rows.push(['0', 'web']);
  const { values, others } = folded(rows).snapshot();
  expect(values.length).toBe(GROUPS_SENT);
  expect(values.slice(0, 3).map((v) => v.value)).toEqual(['0', '1', '10']);
  expect(values[0]).toEqual({
    value: '0',
    cells: [{ rows: 2 }],
    other: { rows: 0 },
    total: { rows: 2 },
  });
  expect(others).toEqual({ values: unsent, rows: unsent });
});
