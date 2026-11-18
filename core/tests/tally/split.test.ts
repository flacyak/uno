/**
 * @fileoverview SplitFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { compareStrings } from '@go';
import { parse } from '@num';
import { ExactSum } from '@tally/exact';
import { DISTINCT_AT_MOST, GROUPS_SENT, LABEL_AT_MOST } from '@tally/groups';
import { PAIRS_AT_MOST, SERIES_AT_MOST, SplitFold } from '@tally/split';
import type { Split } from '@tally/split';
import { seeded } from '@core-tests/lab/cache/stats';

// Enough seeds that edits empty and start cells dozens of times.
const SEEDS = 50;
// Few enough rows per pair that edits empty some cells and start others.
const ROWS = 40;
// Amounts of up to a million in whole cents, whose sums a running total rounds.
const CENTS = 100;
const MOST_CENTS = 1e8;
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

type Row = [value: string, series: string, cell?: string];

function folded(rows: Row[], fold = new SplitFold()): SplitFold {
  for (const row of rows) fold.add(...row);
  return fold;
}

function summed(rows: Row[]): SplitFold {
  return folded(rows, new SplitFold('point'));
}

/** A recount's rows and their numbers, added in the order they come. */
class Recount {
  rows = 0;
  sum = new ExactSum();
  measured = () => ({ rows: this.rows, sum: this.sum.value() });
}

/**
 * counted is what a fold of `rows` that passes no bound reads as, each row's
 * number added straight to every count it belongs to.
 */
function counted(rows: Row[], sums = false): Split {
  const size = (m: { rows: number; sum: number }) => (sums ? m.sum : m.rows);
  const skipped = { blank: 0, unparsed: 0 };
  const number = (cell = '') => {
    const x = sums ? parse(cell, 'point') : undefined;
    if (sums && x === undefined) skipped[cell === '' ? 'blank' : 'unparsed']++;
    return x;
  };
  const totals = new Map<string, Recount>();
  const at = <K>(m: Map<K, Recount>, k: K) => {
    if (!m.has(k)) m.set(k, new Recount());
    return m.get(k)!;
  };
  const xs = rows.map(([, series, cell]) => {
    const x = number(cell);
    const total = at(totals, series);
    total.rows++;
    if (x !== undefined) total.sum.add(x);
    return x;
  });
  const series = [...totals]
    .map(([name, t]) => ({ name, size: size(t.measured()) }))
    .sort((a, b) => b.size - a.size || compareStrings(a.name, b.name))
    .slice(0, SERIES_AT_MOST)
    .map(({ name }) => name);
  const values = [...new Set(rows.map(([value]) => value))]
    .map((value) => {
      const cells = new Map<string, Recount>();
      const other = new Recount();
      const total = new Recount();
      rows.forEach(([v, s], r) => {
        if (v !== value) return;
        for (const into of [series.includes(s) ? at(cells, s) : other, total]) {
          into.rows++;
          if (xs[r] !== undefined) into.sum.add(xs[r]);
        }
      });
      return {
        value,
        cells: series.map((s) => at(cells, s).measured()),
        other: other.measured(),
        total: total.measured(),
      };
    })
    .sort(
      (a, b) =>
        size(b.total) - size(a.total) || compareStrings(a.value, b.value),
    );
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    series,
    values,
    others: none,
    rest: { rows: 0, sum: 0 },
    unsplit: 0,
    skipped,
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

test('a summing split fold moved by edits reads as its rows added again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const amount = () => Math.round((random() * 2 - 1) * MOST_CENTS) / CENTS;
    const cell = () => pick(['', 'n/a', `${amount()}`, `${amount()}`]);
    const row = (): Row => [pick(VALUES), pick(SERIES), cell()];
    const rows = Array.from({ length: ROWS }, row);
    const fold = summed(rows);
    for (let edit = 0; edit < ROWS; edit++) {
      const r = Math.floor(random() * ROWS);
      fold.remove(...rows[r]!);
      rows[r] = row();
      fold.add(...rows[r]);
    }
    expect(fold.snapshot(), `seed ${seed}`).toEqual(counted(rows, true));
  }
});

test('a split sum rounds once, and merges what it does not send', () => {
  // Added in order, 0.1, 0.2 and 0.3 come to 0.6000000000000001.
  const tenths = ['0.1', '0.2', '0.3'];
  const rows: Row[] = tenths.map((x) => ['East', 'web', x]);
  // Seven series of a tenth each, which tie, so the first five are sent.
  for (let i = 0; i < SERIES_AT_MOST + 1; i++)
    rows.push(['East', `${i}`, '0.1']);
  rows.push(['West', 'web', 'n/a']);
  const { series, values, skipped } = summed(rows).snapshot();
  expect(series.slice(0, 2)).toEqual(['web', '0']);
  const east = values[0]!;
  expect(east.cells[0]).toEqual({ rows: 3, sum: 0.6 });
  expect(east.total).toEqual({ rows: 10, sum: 1.3 });
  // Series 5 and 6 are Other.
  expect(east.other).toEqual({ rows: 2, sum: 0.2 });
  expect(values[1]).toMatchObject({
    value: 'West',
    total: { rows: 1, sum: 0 },
  });
  expect(skipped).toEqual({ blank: 0, unparsed: 1 });
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
    cells: [{ rows: 2, sum: 0 }],
    other: { rows: 0, sum: 0 },
    total: { rows: 2, sum: 0 },
  });
  expect(others).toEqual({ values: unsent, rows: unsent, sum: 0 });
});

test('a pair first seen past PAIRS_AT_MOST lands in its value unsplit', () => {
  // Four values whose cells fill the bound between them, in fewer series
  // than DISTINCT_AT_MOST, so every series keeps a total.
  const FILLING = ['a', 'b', 'd', 'e'];
  const each = PAIRS_AT_MOST / FILLING.length;
  const rows: Row[] = [];
  for (const value of FILLING) {
    for (let i = 0; i < each; i++) rows.push([value, `${i}`]);
  }
  const fold = folded(rows);
  fold.add('a', 'late');
  // A cell given up frees a place, but not for a value with unsplit rows.
  fold.remove('b', '0');
  fold.add('a', 'later');
  fold.add('c', 'late');
  for (const value of ['b', 'd', 'e']) fold.add(value, 'late');
  const { values, unsplit, series } = fold.snapshot();
  expect(unsplit).toBe(5);
  // The series still rank over every row, so 'late' is the largest.
  expect(series[0]).toBe('late');
  const at = (value: string) => values.find((v) => v.value === value)!;
  expect(at('a').total).toEqual({ rows: each + 2, sum: 0 });
  expect(at('c').cells[0]).toEqual({ rows: 1, sum: 0 });
  expect(at('c').other).toEqual({ rows: 0, sum: 0 });
  expect(at('b').cells[0]).toEqual({ rows: 0, sum: 0 });
  expect(at('b').total).toEqual({ rows: each, sum: 0 });
  // Taken back, the unsplit rows leave no trace.
  for (const value of FILLING) fold.remove(value, 'late');
  fold.remove('a', 'later');
  expect(fold.snapshot().unsplit).toBe(0);
});

test('values first seen past DISTINCT_AT_MOST are counted in the rest', () => {
  const early = Array.from({ length: DISTINCT_AT_MOST }, (_, i): Row => [
    `${i}`,
    'x',
  ]);
  const fold = folded(early);
  fold.add('late', 'y');
  fold.add('late', 'y');
  fold.remove('0', 'x');
  fold.add('later', 'y');
  const { values, others, rest, series } = fold.snapshot();
  expect(values.length).toBe(GROUPS_SENT);
  expect(others.values).toBe(DISTINCT_AT_MOST - 1 - GROUPS_SENT);
  expect(rest).toEqual({ rows: 3, sum: 0 });
  expect(series).toEqual(['x', 'y']);
});

test('a snapshot cuts each value and series it sends to a label', () => {
  const wide = 'w'.repeat(LABEL_AT_MOST + 1);
  const { series, values } = folded([[wide, wide]]).snapshot();
  expect(series).toEqual([wide.slice(0, LABEL_AT_MOST)]);
  expect(values[0]!.value).toBe(wide.slice(0, LABEL_AT_MOST));
});

test('series first seen past DISTINCT_AT_MOST have no total, so none is sent', () => {
  const early = Array.from({ length: DISTINCT_AT_MOST }, (_, i): Row => [
    `${i % 2}`,
    `${i}`,
  ]);
  const fold = folded(early);
  // The late series has the most rows, but no total to rank it by.
  for (let i = 0; i < SERIES_AT_MOST; i++) fold.add('0', 'late');
  fold.remove('0', '0');
  fold.add('1', 'later');
  const { series, values } = fold.snapshot();
  expect(series).not.toContain('late');
  expect(series).not.toContain('later');
  // Its rows are still in its value, as Other.
  expect(values[0]!.total.rows).toBe(DISTINCT_AT_MOST / 2 + SERIES_AT_MOST - 1);
});
