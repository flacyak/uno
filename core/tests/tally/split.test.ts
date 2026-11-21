/**
 * @fileoverview SplitFold against its rows counted again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { compareStrings } from '@go';
import { parse } from '@num';
import { ExactSum } from '@tally/exact';
import { DISTINCT_AT_MOST, GROUPS_SENT, LABEL_AT_MOST } from '@tally/groups';
import {
  CHORD_NODES_AT_MOST,
  PAIRS_AT_MOST,
  SERIES_AT_MOST,
  SplitFold,
} from '@tally/split';
import type { Split, Square } from '@tally/split';
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
    .map(([name, t]) => ({ name, size: Math.abs(size(t.measured())) }))
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
    below: none,
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

test('a split sum ranks its series by size either side of zero', () => {
  const rows: Row[] = [
    ['East', 'web', '3'],
    ['West', 'loss', '-5'],
  ];
  for (let i = 0; i < SERIES_AT_MOST; i++) rows.push(['East', `${i}`, '1']);
  const { series, values } = summed(rows).snapshot();
  expect(series.slice(0, 2)).toEqual(['loss', 'web']);
  expect(values.map((v) => v.value)).toEqual(['East', 'West']);
  expect(values[1]!.cells[0]).toEqual({ rows: 1, sum: -5 });
  // East's series 4 and 5 are Other, as only six are sent.
  expect(values[0]!.other).toEqual({ rows: 2, sum: 2 });
});

test('unsent values at or below zero are read apart from the others', () => {
  const rows: Row[] = [];
  for (let i = 0; i < GROUPS_SENT; i++) rows.push([`${i}`, 'web', '1']);
  rows.push(['up', 'web', '0.5'], ['even', 'web', '0'], ['down', 'web', '-2']);
  const { others, below } = summed(rows).snapshot();
  expect(others).toEqual({ values: 1, rows: 1, sum: 0.5 });
  expect(below).toEqual({ values: 2, rows: 2, sum: -2 });
});

test('a split snapshot sends the values a person moved first, and the rest largest first', () => {
  const rows: Row[] = [];
  for (let i = 0; i < GROUPS_SENT + 1; i++) {
    for (let r = 0; r <= i; r++) rows.push([`${i}`, 'web']);
  }
  const { values, others } = folded(rows).snapshot(['0', '3']);
  expect(values.slice(0, 3).map((v) => v.value)).toStrictEqual([
    '0',
    '3',
    `${GROUPS_SENT}`,
  ]);
  expect(values.length).toBe(GROUPS_SENT);
  expect(others.values).toBe(1);
});

test("a summing split fold moved by edits counts each cell's numbers and blanks as its rows do", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const cell = () => pick(['', 'n/a', '1.5', '-2']);
    const row = (): Row => [pick(VALUES), pick(SERIES), cell()];
    const rows = Array.from({ length: ROWS }, row);
    const fold = summed(rows);
    for (let edit = 0; edit < ROWS; edit++) {
      const r = Math.floor(random() * ROWS);
      fold.remove(...rows[r]!);
      rows[r] = row();
      fold.add(...rows[r]);
    }
    for (const { value, cells } of fold.saved().groups) {
      for (const [series, , , numbers, blank] of cells) {
        const own = rows.filter(([v, s]) => v === value && s === series);
        const read = own.filter(
          ([, , c = '']) => parse(c, 'point') !== undefined,
        );
        expect([numbers, blank], `seed ${seed}`).toStrictEqual([
          read.length,
          own.filter(([, , c]) => c === '').length,
        ]);
      }
    }
  }
});

test("a slope reads two series of a split fold, each value's cell in each as its rows, sum and numbers, the larger end first", () => {
  const fold = summed([
    ['East', '2024', '10'],
    ['East', '2025', '30'],
    ['East', '2025', 'n/a'],
    ['West', '2024', '50'],
    ['North', '2026', '99'],
    ['North', '2026', ''],
    ['South', '2025', '20'],
  ]);
  const { values, others, skipped } = fold.slope(['2024', '2025'], false);
  // East's n/a is left out of the two states, and North's blank of neither.
  expect(skipped).toStrictEqual({ blank: 0, unparsed: 1 });
  // North has no row in either, and stands in no slope.
  expect(values.map((v) => [v.value, v.ends])).toStrictEqual([
    [
      'West',
      [
        { rows: 1, sum: 50, numbers: 1 },
        { rows: 0, sum: 0, numbers: 0 },
      ],
    ],
    [
      'East',
      [
        { rows: 1, sum: 10, numbers: 1 },
        { rows: 2, sum: 30, numbers: 1 },
      ],
    ],
    [
      'South',
      [
        { rows: 0, sum: 0, numbers: 0 },
        { rows: 1, sum: 20, numbers: 1 },
      ],
    ],
  ]);
  expect(others).toStrictEqual({ values: 0, rows: 0 });
  // By mean, East's 30 over one number passes South's 20.
  const means = fold.slope(['2024', '2025'], true).values.map((v) => v.value);
  expect(means).toStrictEqual(['West', 'East', 'South']);
  // A count ranks by rows: East's two.
  const rows = folded([
    ['a', 'x'],
    ['b', 'y'],
    ['b', 'y'],
  ]).slope(['x', 'y'], false);
  expect(rows.values.map((v) => v.value)).toStrictEqual(['b', 'a']);
});

test('a slope says which values a fold kept apart from their series past PAIRS_AT_MOST, and counts the values it sends none of', () => {
  // Two series of every value fill the pairs, so v0's row in y has no cell.
  const fold = new SplitFold();
  const values = PAIRS_AT_MOST / 2;
  for (let i = 0; i < values; i++) {
    fold.add(`v${i}`, 'x');
    fold.add(`v${i}`, 'z');
  }
  fold.add('v0', 'y');
  const slope = fold.slope(['x', 'y'], false);
  expect(slope.values.find((v) => v.value === 'v0')?.unsplit).toBe(true);
  expect(slope.values.filter((v) => v.unsplit)).toHaveLength(1);
  expect(slope.values).toHaveLength(GROUPS_SENT);
  expect(slope.others).toStrictEqual({
    values: values - GROUPS_SENT,
    rows: values - GROUPS_SENT,
  });
});

test('a split fold is whole while every row is in its cell, none apart past PAIRS_AT_MOST or DISTINCT_AT_MOST', () => {
  const fold = new SplitFold();
  const values = PAIRS_AT_MOST / 2;
  for (let i = 0; i < values; i++) {
    fold.add(`v${i}`, 'x');
    fold.add(`v${i}`, 'z');
  }
  expect(fold.whole()).toBe(true);
  fold.add('v0', 'y');
  expect(fold.whole()).toBe(false);
  fold.remove('v0', 'y');
  expect(fold.whole()).toBe(true);
  for (let i = values; i <= DISTINCT_AT_MOST; i++) fold.add(`v${i}`, 'x');
  expect(fold.whole()).toBe(false);
});

// More names than a square sends, each both a from and a to.
const NAMES = ['', 'ORD', 'JFK', 'LAX', 'ATL', 'DEN', 'SEA', 'SFO', 'BOS'];

/**
 * squared is the square a fold of `rows` that passes no bound reads as: each
 * name's rows out and in, the largest named, and each row in the cell of its
 * from and its to, Other where either is not named.
 */
function squared(rows: Row[], sums = false): Square {
  const skipped = { blank: 0, unparsed: 0 };
  const xs = rows.map(([, , cell = '']) => {
    const x = sums ? parse(cell, 'point') : undefined;
    if (sums && x === undefined) skipped[cell === '' ? 'blank' : 'unparsed']++;
    return x;
  });
  const counts = (r: number[]) => {
    const c = new Recount();
    for (const i of r) {
      c.rows++;
      if (xs[i] !== undefined) c.sum.add(xs[i]);
    }
    return c.measured();
  };
  const size = (m: { rows: number; sum: number }) =>
    Math.abs(sums ? m.sum : m.rows);
  const rowsOf = (keep: (row: Row) => boolean) =>
    rows.flatMap((row, i) => (keep(row) ? [i] : []));
  const names = [...new Set(rows.flatMap(([from, to]) => [from, to]))];
  const nodes = names
    .map((name) => ({
      name,
      size:
        size(counts(rowsOf(([from]) => from === name))) +
        size(counts(rowsOf(([, to]) => to === name))),
    }))
    .sort((a, b) => b.size - a.size || compareStrings(a.name, b.name))
    .slice(0, CHORD_NODES_AT_MOST)
    .map(({ name }) => name);
  const place = (name: string) =>
    nodes.includes(name) ? nodes.indexOf(name) : nodes.length;
  const places = Array.from({ length: nodes.length + 1 }, (_, i) => i);
  return {
    nodes,
    flows: places.map((i) =>
      places.map((j) =>
        counts(rowsOf(([from, to]) => place(from) === i && place(to) === j)),
      ),
    ),
    others: names.length - nodes.length,
    unsplit: 0,
    rest: { rows: 0, sum: 0 },
    skipped,
  };
}

test('a square reads each flow between the names with the most rows out and in, the rest as Other, as its rows counted again', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const cents = () => `${Math.floor(random() * MOST_CENTS) / CENTS}`;
    const row = (): Row => [pick(NAMES), pick(NAMES), pick([cents(), ''])];
    const rows = Array.from({ length: ROWS }, row);
    const [rowed, sum] = [folded(rows), summed(rows)];
    expect(rowed.square(), `seed ${seed}`).toEqual(squared(rows));
    expect(sum.square(), `seed ${seed}, summed`).toEqual(squared(rows, true));
    for (let edit = 0; edit < ROWS; edit++) {
      const r = Math.floor(random() * ROWS);
      for (const fold of [rowed, sum]) fold.remove(...rows[r]!);
      rows[r] = row();
      for (const fold of [rowed, sum]) fold.add(...rows[r]);
    }
    expect(sum.square(), `seed ${seed}, edited`).toEqual(squared(rows, true));
  }
});

test('a square counts a row past PAIRS_AT_MOST from its value to Other, and the rest from Other to Other', () => {
  // Four series of every value fill the pairs, so a's row to b has no cell.
  const SERIES_EACH = ['a', 'b', 'c', 'd'];
  const values = PAIRS_AT_MOST / SERIES_EACH.length;
  const fold = new SplitFold();
  for (let i = 0; i < values; i++) {
    for (const series of SERIES_EACH) fold.add(`v${i}`, series);
  }
  fold.add('a', 'b');
  const { nodes, flows, others, unsplit } = fold.square();
  const other = CHORD_NODES_AT_MOST;
  expect(nodes).toStrictEqual([...SERIES_EACH, 'v0', 'v1']);
  expect(flows[0]![1]).toStrictEqual({ rows: 0, sum: 0 });
  expect(flows[0]![other]).toStrictEqual({ rows: 1, sum: 0 });
  expect(flows[4]![0]).toStrictEqual({ rows: 1, sum: 0 });
  expect(flows[other]![0]).toStrictEqual({ rows: values - 2, sum: 0 });
  expect(unsplit).toBe(1);
  expect(others).toBe(values + SERIES_EACH.length - CHORD_NODES_AT_MOST);
  // A value first seen past DISTINCT_AT_MOST has no group, so its row is Other's.
  const full = new SplitFold();
  for (let i = 0; i < DISTINCT_AT_MOST; i++) full.add(`v${i}`, 'a');
  full.add('late', 'a');
  const square = full.square();
  expect(square.nodes[0]).toBe('a');
  expect(square.rest).toStrictEqual({ rows: 1, sum: 0 });
  expect(square.flows[other]![other]).toStrictEqual({ rows: 1, sum: 0 });
});
