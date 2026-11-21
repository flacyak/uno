/**
 * @fileoverview A fold a save wrote reads back as the fold it was, bit for
 * bit, so rows added after the reopen fold as they would have into the fold
 * before it, and the folds of a fixed file are pinned to TALLY_VERSION.
 */

import { expect, test } from 'vite-plus/test';

import { readDate } from '@date';
import { hashOf } from '@engine/grown';
import { read } from '@ingest';
import {
  BOX_VALUES_AT_MOST,
  DISTINCT_AT_MOST,
  ExactSum,
  GroupsFold,
  HELD_AT_MOST,
  PAIRS_AT_MOST,
  SPREAD_AT_MOST,
  SampleFold,
  pointsOf,
  restoredPoints,
  savedPoints,
  SpreadFold,
  SpreadsFold,
  SplitFold,
  SwarmFold,
  TALLY_VERSION,
  TimeFold,
  TimeSplitFold,
  WEEK_HOURS,
  WeekFold,
} from '@tally';
import { UINT32_RANGE, seeded } from '@core-tests/lab/cache/stats';
import {
  CHANNEL,
  REGION,
  REVENUE,
  UNITS,
  bytes,
} from '@core-tests/testdata/sales-q3';

const SEEDS = 200;
// The fixture's first column, its dates, and its third, its reps.
const DATE = 0;
const REP = 2;
const DRAWS = 48;
const HALF = DRAWS / 2;
const encoder = new TextEncoder();

/** throughJson is `v` as a save writes it and a reopen reads it. */
function throughJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/** bits returns doubles of every size and sign, from random bits. */
function bits(seed: number): number[] {
  const random = seeded(seed);
  const doubles = new Float64Array(DRAWS);
  const words = new Uint32Array(doubles.buffer);
  for (let i = 0; i < words.length; i++) words[i] = random() * UINT32_RANGE;
  return [...doubles].filter(Number.isFinite);
}

test('an exact sum read back from its save adds on as the sum it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const xs = bits(seed);
    const whole = new ExactSum();
    const before = new ExactSum();
    for (const x of xs) whole.add(x);
    for (const x of xs.slice(0, HALF)) before.add(x);
    const after = ExactSum.restored(throughJson(before.saved()))!;
    for (const x of xs.slice(HALF)) after.add(x);
    expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
    expect(Object.is(after.value(), whole.value()), `seed ${seed}`).toBe(true);
  }
});

test('a save that holds no exact sum reads back as none', () => {
  const unsaved = [
    undefined,
    [],
    { partials: [1], units: 0.5 },
    { partials: [0], units: 0 },
    { partials: [2 ** 1023], units: 0 },
    { partials: ['1'], units: 0 },
  ];
  for (const v of unsaved) expect(ExactSum.restored(v)).toBeUndefined();
});

/** Rows of values and cells, with blanks, words and both decimal marks. */
const CELLS = ['', 'n/a', '1,5', '1.204,50', '-3', '(0.50)', '$1,200.50'];

test('a groups fold read back from its save folds on as the fold it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const values = ['', 'East', 'West', 'North America'];
    const rows = Array.from({ length: DRAWS }, (): [string, string] => [
      pick(values),
      pick(CELLS),
    ]);
    for (const make of [
      () => new GroupsFold(),
      () => new GroupsFold('sum', 'point'),
      () => new GroupsFold('sum', 'comma'),
    ]) {
      // An edit takes the first row back before the save, and puts it back
      // after it.
      const first = (fold: GroupsFold) => {
        for (const r of rows.slice(0, HALF)) fold.add(...r);
        fold.remove(...rows[0]!);
      };
      const then = (fold: GroupsFold) => {
        for (const r of rows.slice(HALF)) fold.add(...r);
        fold.add(...rows[0]!);
      };
      const [whole, before] = [make(), make()];
      first(whole);
      then(whole);
      first(before);
      const after = GroupsFold.restored(throughJson(before.saved()))!;
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.snapshot(), `seed ${seed}`).toStrictEqual(whole.snapshot());
    }
  }
});

test('a groups fold past DISTINCT_AT_MOST reads back with its rest', () => {
  const fold = new GroupsFold('sum', 'point');
  for (let v = 0; v <= DISTINCT_AT_MOST; v++) fold.add(`${v}`, `${v}.25`);
  const after = GroupsFold.restored(throughJson(fold.saved()))!;
  after.add('new', '1');
  fold.add('new', '1');
  expect(after.snapshot()).toStrictEqual(fold.snapshot());
  expect(after.snapshot().rest.rows).toBe(2);
});

test('a save that holds no groups fold reads back as none', () => {
  const saved = new GroupsFold('sum', 'point').saved();
  const unsaved = [
    undefined,
    { ...saved, mark: 'dot' },
    { ...saved, skipped: { blank: -1, unparsed: 0 } },
    { ...saved, groups: [{ value: 'East', rows: 0, sum: saved.rest.sum }] },
    { ...saved, groups: [{ value: 'East', rows: 1 }] },
    { ...saved, rest: { rows: 0 } },
  ];
  for (const v of unsaved) expect(GroupsFold.restored(v)).toBeUndefined();
});

test('a mean fold read back from its save folds on as the fold it was, its counts of numbers with it', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const rows = Array.from({ length: DRAWS }, (): [string, string] => [
      pick(['', 'East', 'West']),
      pick(CELLS),
    ]);
    for (const mark of ['point', 'comma'] as const) {
      const [whole, before] = [
        new GroupsFold('mean', mark),
        new GroupsFold('mean', mark),
      ];
      for (const r of rows) whole.add(...r);
      for (const r of rows.slice(0, HALF)) before.add(...r);
      const after = GroupsFold.restored(throughJson(before.saved()))!;
      for (const r of rows.slice(HALF)) after.add(...r);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.means(), `seed ${seed}`).toStrictEqual(whole.means());
    }
  }
});

test('a save that holds no mean fold reads back as none', () => {
  const fold = new GroupsFold('mean', 'point');
  fold.add('East', '2');
  const saved = fold.saved();
  const [east] = saved.groups;
  const unsaved = [
    { ...saved, mark: undefined },
    { ...saved, groups: [{ ...east, numbers: undefined }] },
    { ...saved, groups: [{ ...east, numbers: 2 }] },
    { ...saved, groups: [{ ...east, numbers: -1 }] },
    { ...saved, rest: { rows: 0, sum: saved.rest.sum } },
  ];
  for (const v of unsaved)
    expect(GroupsFold.restored(throughJson(v))).toBeUndefined();
  expect(GroupsFold.restored(throughJson(saved))?.means()).toStrictEqual(
    fold.means(),
  );
});

test('a split fold saves each count in the order it began, with its exact sum, its cells that read as numbers and its blank ones', () => {
  const fold = new SplitFold('point');
  fold.add('East', 'web', '1.5');
  fold.add('East', 'direct', 'n/a');
  fold.add('East', 'web', '');
  fold.add('West', 'web', '-2');
  const sum = (...xs: number[]) => {
    const s = new ExactSum();
    for (const x of xs) s.add(x);
    return s.saved();
  };
  const none = sum();
  expect(throughJson(fold.saved())).toStrictEqual({
    mark: 'point',
    groups: [
      {
        value: 'East',
        cells: [
          ['web', 2, sum(1.5), 1, 1],
          ['direct', 1, none, 0, 0],
        ],
        unsplit: { rows: 0, sum: none, numbers: 0, blank: 0 },
      },
      {
        value: 'West',
        cells: [['web', 1, sum(-2), 1, 0]],
        unsplit: { rows: 0, sum: none, numbers: 0, blank: 0 },
      },
    ],
    rest: { rows: 0, sum: none, numbers: 0, blank: 0 },
    totals: [
      ['web', 3, sum(1.5, -2), 2, 1],
      ['direct', 1, none, 0, 0],
    ],
    totalsRest: { rows: 0, sum: none, numbers: 0, blank: 0 },
    skipped: { blank: 1, unparsed: 1 },
  });
  const counted = new SplitFold();
  counted.add('East', 'web');
  expect(throughJson(counted.saved())).toStrictEqual({
    groups: [{ value: 'East', cells: [['web', 1]], unsplit: { rows: 0 } }],
    rest: { rows: 0 },
    totals: [['web', 1]],
    totalsRest: { rows: 0 },
    skipped: { blank: 0, unparsed: 0 },
  });
});

test('a split fold read back from its save folds on as the fold it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const values = ['', 'East', 'West', 'North America'];
    const series = ['', 'web', 'direct'];
    const rows = Array.from({ length: DRAWS }, (): [string, string, string] => [
      pick(values),
      pick(series),
      pick(CELLS),
    ]);
    for (const make of [
      () => new SplitFold(),
      () => new SplitFold('point'),
      () => new SplitFold('comma'),
    ]) {
      // An edit takes the first row back before the save, and puts it back
      // after it.
      const first = (fold: SplitFold) => {
        for (const r of rows.slice(0, HALF)) fold.add(...r);
        fold.remove(...rows[0]!);
      };
      const then = (fold: SplitFold) => {
        for (const r of rows.slice(HALF)) fold.add(...r);
        fold.add(...rows[0]!);
      };
      const [whole, before] = [make(), make()];
      first(whole);
      then(whole);
      first(before);
      const saved = JSON.stringify(before.saved());
      const after = SplitFold.restored(JSON.parse(saved))!;
      expect(JSON.stringify(after.saved()), `seed ${seed}`).toBe(saved);
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.snapshot(), `seed ${seed}`).toStrictEqual(whole.snapshot());
    }
  }
});

test('a split fold past PAIRS_AT_MOST reads back with its unsplit rows', () => {
  const fold = new SplitFold('point');
  const each = PAIRS_AT_MOST / 2;
  for (const value of ['a', 'b']) {
    for (let i = 0; i < each; i++) fold.add(value, `${i}`, '1');
  }
  fold.add('a', 'late', '2');
  const after = SplitFold.restored(throughJson(fold.saved()))!;
  // A place freed goes to a value with no unsplit rows, after as before.
  for (const f of [fold, after]) {
    f.remove('b', '0', '1');
    f.add('a', 'later', '3');
    f.add('b', 'later', '4');
  }
  expect(after.saved()).toStrictEqual(fold.saved());
  expect(after.snapshot().unsplit).toBe(2);
});

test('a save that holds no split fold reads back as none', () => {
  const fold = new SplitFold('point');
  fold.add('East', 'web', '1');
  const saved = fold.saved();
  const [group] = saved.groups;
  const cell = group!.cells[0]!;
  const unsaved = [
    undefined,
    { ...saved, mark: 'dot' },
    { ...saved, skipped: { blank: -1, unparsed: 0 } },
    { ...saved, rest: { rows: 1 } },
    { ...saved, totalsRest: undefined },
    { ...saved, groups: [group, group] },
    { ...saved, groups: [{ ...group, cells: [cell, cell] }] },
    { ...saved, groups: [{ ...group, cells: [] }] },
    { ...saved, groups: [{ ...group, cells: [['web', 0, cell[2], 0, 0]] }] },
    { ...saved, groups: [{ ...group, cells: [['web', 1]] }] },
    // A sum saved before cells counted their numbers, and more numbers and blanks than rows.
    { ...saved, groups: [{ ...group, cells: [['web', 1, cell[2]]] }] },
    { ...saved, groups: [{ ...group, cells: [['web', 1, cell[2], 1, 1]] }] },
    { ...saved, rest: { rows: 0, sum: cell[2] } },
    { ...saved, totals: [[1, 1, cell[2]]] },
    {
      ...saved,
      totals: Array.from({ length: DISTINCT_AT_MOST + 1 }, () => cell),
    },
  ];
  for (const v of unsaved) expect(SplitFold.restored(v)).toBeUndefined();
  expect(SplitFold.restored(throughJson(saved))).toBeDefined();
});

/** Blocks a page of a scatter's least and most holds, and rows a block. */
const PAGE_BLOCKS = 256;
const BLOCK_ROWS = 4;
/** Rows over two pages and a part of a third. */
const PAGED_ROWS = (2 * PAGE_BLOCKS + 3) * BLOCK_ROWS;
const POINTS = ['point', 'point'] as const;

/** paged is a row's x and y over PAGED_ROWS, with a word and a blank. */
function paged(row: number): [string, string] {
  if (row % 7 === 0) return ['n/a', `${row}`];
  return [`${(row * 37) % 1000}.5`, row % 5 === 0 ? '' : `${-row}`];
}

/** scattered folds `rows` of PAGED_ROWS, BLOCK_ROWS a block. */
function scattered(rows: number[], fold = new SampleFold(POINTS)): SampleFold {
  for (const row of rows) {
    fold.add(Math.floor(row / BLOCK_ROWS), row, ...paged(row));
  }
  return fold;
}

const range = (from: number, end: number) =>
  Array.from({ length: end - from }, (_, i) => from + i);

test('a scatter fold saves the least and most of each page of blocks', () => {
  const fold = scattered(range(0, PAGED_ROWS));
  const saved = savedPoints(fold.saved());
  expect(throughJson(saved)).toEqual(saved);
  expect(saved.pages.map(({ first, span }) => [first, span])).toEqual([
    [0, PAGE_BLOCKS],
    [PAGE_BLOCKS, PAGE_BLOCKS],
    [2 * PAGE_BLOCKS, 3],
  ]);
  // Each page's least and most are those of its rows alone.
  for (const { first, span, least, most } of saved.pages) {
    const rows = range(first * BLOCK_ROWS, (first + span) * BLOCK_ROWS);
    const alone = pointsOf(scattered(rows).snapshot());
    expect({ least, most }).toEqual({ least: alone.least, most: alone.most });
  }
  expect(saved.kept.length).toBeGreaterThan(0);
  expect(saved.plotted).toBe(fold.snapshot().plotted);
});

test('a scatter fold read back from its save folds on as the fold it was', () => {
  const half = (PAGE_BLOCKS + 1) * BLOCK_ROWS;
  const before = scattered(range(0, half));
  const after = scattered(
    range(half, PAGED_ROWS),
    restoredPoints(throughJson(savedPoints(before.saved()))),
  );
  const whole = scattered(range(0, PAGED_ROWS));
  expect(after.snapshot()).toStrictEqual(whole.snapshot());
  expect(after.stale()).toEqual([]);
});

test("an edit of a read back page's least or most folds each of its blocks again", () => {
  const rows = range(0, PAGED_ROWS);
  const page = savedPoints(scattered(rows).saved()).pages[1]!;
  const firstRow = page.first * BLOCK_ROWS;
  // A row inside the page's least and most, then the one on its most x.
  const inside = firstRow + 1;
  const top = rows.find(
    (r) => r >= firstRow && paged(r)[0] === `${page.most.x}`,
  )!;
  const edits = new Map<number, [string, string]>([
    [inside, ['1.5', '-1']],
    [top, ['0.5', '-1']],
  ]);
  const cells = (row: number) => edits.get(row) ?? paged(row);
  /** mended edits `row`, then folds each block it left stale again. */
  const mended = (fold: SampleFold, row: number): number[] => {
    const block = Math.floor(row / BLOCK_ROWS);
    fold.remove(block, row, ...paged(row));
    fold.add(block, row, ...cells(row));
    const stale = fold.stale();
    for (const b of stale) {
      const alone = new SampleFold(POINTS);
      for (const r of range(b * BLOCK_ROWS, (b + 1) * BLOCK_ROWS)) {
        alone.add(b, r, ...cells(r));
      }
      fold.refold(b, alone);
    }
    return stale;
  };
  const fold = restoredPoints(
    throughJson(savedPoints(scattered(rows).saved())),
  )!;
  const whole = scattered(rows);
  expect(mended(fold, inside)).toEqual([]);
  expect(mended(fold, top)).toEqual(range(page.first, page.first + page.span));
  mended(whole, inside);
  expect(mended(whole, top)).toEqual([Math.floor(top / BLOCK_ROWS)]);
  expect(fold.snapshot()).toStrictEqual(whole.snapshot());
});

test('a read back page gives a block back to fold again whole, and leaves no block stale', () => {
  const rows = range(0, PAGED_ROWS);
  const fold = restoredPoints(
    throughJson(savedPoints(scattered(rows).saved())),
  )!;
  const block = PAGE_BLOCKS + 1;
  const alone = range(block * BLOCK_ROWS, (block + 1) * BLOCK_ROWS);
  for (const row of alone) fold.forget(row, ...paged(row));
  fold.refold(block, new SampleFold(POINTS));
  expect(fold.stale()).toEqual([]);
  scattered(alone, fold);
  expect(fold.snapshot()).toStrictEqual(scattered(rows).snapshot());
});

test('a save that holds no scatter fold reads back as none', () => {
  const saved = savedPoints(scattered(range(0, BLOCK_ROWS)).saved());
  const page = saved.pages[0]!;
  const unsaved = [
    undefined,
    { ...saved, marks: { x: 'point', y: 'dot' } },
    { ...saved, plotted: -1 },
    { ...saved, kept: [[1, 2]] },
    { ...saved, kept: [[1, null, 2]] },
    { ...saved, pages: [{ ...page, first: 1 }] },
    { ...saved, pages: [{ ...page, span: PAGE_BLOCKS + 1 }] },
    { ...saved, pages: [{ ...page, least: page.most, most: page.least }] },
  ];
  for (const v of unsaved) expect(restoredPoints(v)).toBeUndefined();
});

test('a sample fold of three columns read back from its save folds on as the fold it was', () => {
  const cells = (row: number) => [...paged(row), `${row}`];
  const fold = (
    rows: number[],
    into = new SampleFold(['point', 'point', 'point']),
  ) => {
    for (const row of rows)
      into.add(Math.floor(row / BLOCK_ROWS), row, ...cells(row));
    return into;
  };
  const half = (PAGE_BLOCKS + 1) * BLOCK_ROWS;
  const saved = fold(range(0, half)).saved();
  expect(saved.pages[0]!.least).toHaveLength(3);
  const after = fold(
    range(half, PAGED_ROWS),
    SampleFold.restored(throughJson(saved)),
  );
  expect(after.snapshot()).toStrictEqual(fold(range(0, PAGED_ROWS)).snapshot());
  // A kept row or a page of another count of columns is no save of it.
  const page = saved.pages[0]!;
  const unsaved = [
    { ...saved, marks: [] },
    { ...saved, kept: [[1, 2, 3]] },
    { ...saved, pages: [{ ...page, least: [0, 0] }] },
  ];
  for (const v of unsaved) expect(SampleFold.restored(v)).toBeUndefined();
});

test('a swarm fold read back from its save folds on as the fold it was', () => {
  const regions = ['North', 'South', 'East'];
  const fold = (rows: number[], into = new SwarmFold('point')) => {
    for (const row of rows) {
      const [x] = paged(row);
      into.add(Math.floor(row / BLOCK_ROWS), row, regions[row % 3]!, x);
    }
    return into;
  };
  const half = (PAGE_BLOCKS + 1) * BLOCK_ROWS;
  const saved = fold(range(0, half)).saved();
  const back = SwarmFold.restored(throughJson(saved));
  const after = fold(range(half, PAGED_ROWS), back);
  expect(after.snapshot()).toStrictEqual(fold(range(0, PAGED_ROWS)).snapshot());
  // A value twice or empty, a sample of two columns or past its rows, or a kept row of two numbers is no save of it.
  const [first] = saved.values;
  const unsaved = [
    { ...saved, values: [first, first] },
    { ...saved, values: [['North', { ...first![1], rows: 0, plotted: 0 }]] },
    { ...saved, all: { ...saved.all, marks: ['point', 'point'] } },
    { ...saved, rest: { ...saved.rest, plotted: saved.rest.rows + 1 } },
    { ...saved, rest: { ...saved.rest, kept: [[1, 2, 3]] } },
  ];
  for (const v of unsaved)
    expect(SwarmFold.restored(throughJson(v))).toBeUndefined();
});

/** Dates in every layout, blank, not dates, and dates only one order reads. */
const DATES = [
  '',
  'n/a',
  '2024-03-04',
  '2024-03-04 9:05',
  '03/04/2024 23:59:59',
  '13/04/2024',
  '04/13/2024 0:30',
  '2024-03-04T23:30:00-05:00',
  '1700000000',
];

test('a time fold read back from its save folds on as the fold it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const rows = Array.from({ length: DRAWS }, (): [string, string] => [
      pick(DATES),
      pick(CELLS),
    ]);
    for (const make of [
      () => new TimeFold('day'),
      () => new TimeFold('month', 'point'),
      () => new TimeFold('s', 'comma'),
    ]) {
      // An edit takes the first row back before the save, and puts it back
      // after it.
      const first = (fold: TimeFold) => {
        for (const r of rows.slice(0, HALF)) fold.add(...r);
        fold.remove(...rows[0]!);
      };
      const then = (fold: TimeFold) => {
        for (const r of rows.slice(HALF)) fold.add(...r);
        fold.add(...rows[0]!);
      };
      const [whole, before] = [make(), make()];
      first(whole);
      then(whole);
      first(before);
      const after = TimeFold.restored(throughJson(before.saved()))!;
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.read(), `seed ${seed}`).toStrictEqual(whole.read());
    }
  }
});

const HOUR_MINUTES = 60;
const MINUTE_MS = 60_000;

/** The cell of the hour `hour` hours after 1970. */
function hourCell(hour: number): string {
  const iso = new Date(hour * HOUR_MINUTES * MINUTE_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

test('a time fold that coarsened reads back coarse', () => {
  const fold = new TimeFold('day', 'point');
  for (let h = 0; h <= HELD_AT_MOST; h++) fold.add(hourCell(h), `${h}.25`);
  const after = TimeFold.restored(throughJson(fold.saved()))!;
  expect(after.read().held).toBe('day');
  after.add(hourCell(0), '1');
  fold.add(hourCell(0), '1');
  expect(after.saved()).toStrictEqual(fold.saved());
});

test('a save that holds no time fold reads back as none', () => {
  const fold = new TimeFold('day', 'point');
  fold.add('2024-03-04', '1');
  const saved = fold.saved();
  const [key, rows, sum] = saved.periods[0]!;
  const yearOf = (k: number) => ({
    ...saved,
    held: 'year',
    periods: [[k, 1, sum]],
  });
  // Hours, all in 1970, one past the bound.
  const hours = Array.from({ length: HELD_AT_MOST + 1 }, (_, h) => [h, 1, sum]);
  const unsaved = [
    undefined,
    { ...saved, reading: 'week' },
    { ...saved, mark: 'dot' },
    { ...saved, held: 'week' },
    { ...saved, timed: -1 },
    { ...saved, dates: { blank: 0, unparsed: 0 } },
    { ...saved, skipped: { blank: 0.5, unparsed: 0 } },
    { ...saved, undated: { rows: 0 } },
    { ...saved, periods: [[key, 0, sum]] },
    { ...saved, periods: [[key, rows]] },
    { ...saved, periods: [[key + 0.5, rows, sum]] },
    { ...saved, periods: [saved.periods[0], saved.periods[0]] },
    { ...saved, held: 'hour', periods: hours },
    // Years 0000 and 9999 are -1970 and 8029; one either side is past them.
    yearOf(-1971),
    yearOf(8030),
  ];
  for (const v of unsaved) expect(TimeFold.restored(v)).toBeUndefined();
  expect(TimeFold.restored(yearOf(-1970))).toBeDefined();
  expect(TimeFold.restored(yearOf(8029))).toBeDefined();
});

test('a week fold read back from its save folds on as the fold it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const rows = Array.from({ length: DRAWS }, (): [string, string] => [
      pick(DATES),
      pick(CELLS),
    ]);
    for (const make of [
      () => new WeekFold('day'),
      () => new WeekFold('month', 'point'),
      () => new WeekFold('s', 'comma'),
    ]) {
      // An edit takes the first row back before the save, and puts it back
      // after it.
      const first = (fold: WeekFold) => {
        for (const r of rows.slice(0, HALF)) fold.add(...r);
        fold.remove(...rows[0]!);
      };
      const then = (fold: WeekFold) => {
        for (const r of rows.slice(HALF)) fold.add(...r);
        fold.add(...rows[0]!);
      };
      const [whole, before] = [make(), make()];
      first(whole);
      then(whole);
      first(before);
      const after = WeekFold.restored(throughJson(before.saved()))!;
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.snapshot(), `seed ${seed}`).toStrictEqual(whole.snapshot());
    }
  }
});

test("a week fold saves the hours that hold a row, in the week's order", () => {
  const fold = new WeekFold('day');
  fold.add('2024-03-09 23:00');
  fold.add('2024-03-03 01:00');
  fold.add('2024-03-03 01:30');
  expect(throughJson(fold.saved())).toStrictEqual({
    reading: 'day',
    timed: 3,
    hours: [
      [1, 2],
      [WEEK_HOURS - 1, 1],
    ],
    undated: { rows: 0 },
    dates: { blank: 0, unparsed: 0, other: 0 },
    skipped: { blank: 0, unparsed: 0 },
  });
});

test('a save that holds no week fold reads back as none', () => {
  const fold = new WeekFold('day', 'point');
  fold.add('2024-03-03 01:00', '1');
  fold.add('2024-03-04 01:00', '2');
  const saved = fold.saved();
  const [sunday, monday] = saved.hours as [
    [number, number, unknown],
    [number, number, unknown],
  ];
  const [hour, rows, sum] = sunday;
  const unsaved = [
    undefined,
    { ...saved, reading: 'week' },
    { ...saved, mark: 'dot' },
    { ...saved, timed: -1 },
    { ...saved, dates: { blank: 0, unparsed: 0 } },
    { ...saved, skipped: { blank: 0.5, unparsed: 0 } },
    { ...saved, undated: { rows: 0 } },
    { ...saved, hours: [[hour, 0, sum]] },
    { ...saved, hours: [[hour, rows]] },
    { ...saved, hours: [[hour + 0.5, rows, sum]] },
    { ...saved, hours: [[-1, rows, sum]] },
    { ...saved, hours: [[WEEK_HOURS, rows, sum]] },
    { ...saved, hours: [sunday, sunday] },
    { ...saved, hours: [monday, sunday] },
  ];
  for (const v of unsaved) expect(WeekFold.restored(v)).toBeUndefined();
  expect(WeekFold.restored(throughJson(saved))?.saved()).toStrictEqual(saved);
});

test('a time split fold read back from its save folds on as the fold it was', () => {
  const values = ['North', 'South', ''];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const rows = Array.from({ length: DRAWS }, (): [string, string, string] => [
      pick(values),
      pick(DATES),
      pick(CELLS),
    ]);
    for (const make of [
      () => new TimeSplitFold('day'),
      () => new TimeSplitFold('month', 'point'),
      () => new TimeSplitFold('s', 'comma'),
    ]) {
      // An edit takes the first row back before the save, and puts it back after it.
      const first = (fold: TimeSplitFold) => {
        for (const r of rows.slice(0, HALF)) fold.add(...r);
        fold.remove(...rows[0]!);
      };
      const then = (fold: TimeSplitFold) => {
        for (const r of rows.slice(HALF)) fold.add(...r);
        fold.add(...rows[0]!);
      };
      const [whole, before] = [make(), make()];
      first(whole);
      then(whole);
      first(before);
      const after = TimeSplitFold.restored(throughJson(before.saved()))!;
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.read(), `seed ${seed}`).toStrictEqual(whole.read());
    }
  }
});

test('a save that holds no time split fold reads back as none', () => {
  const fold = new TimeSplitFold('day', 'point');
  fold.add('North', '2024-03-04', '1');
  const saved = fold.saved();
  const group = saved.groups[0]!;
  const [key, rows, sum] = group.periods[0]!;
  const as = (g: object) => ({ ...saved, groups: [{ ...group, ...g }] });
  const unsaved = [
    undefined,
    { ...saved, reading: 'week' },
    { ...saved, mark: 'dot' },
    { ...saved, held: 'week' },
    { ...saved, dates: { blank: 0, unparsed: 0 } },
    { ...saved, rest: { rows: 0 } },
    { ...saved, groups: [group, group] },
    as({ value: 1 }),
    as({ periods: [[key, 0, sum]] }),
    as({ periods: [[key, rows]] }),
    as({ periods: [[key + 0.5, rows, sum]] }),
    as({ periods: [group.periods[0], group.periods[0]] }),
    as({ undated: { rows: -1, sum } }),
    // Rows unsplit while hours are held, and a year past 9999.
    as({ unsplit: { rows: 1, sum } }),
    { ...as({ periods: [[8_030, 1, sum]] }), held: 'year' },
  ];
  for (const v of unsaved) expect(TimeSplitFold.restored(v)).toBeUndefined();
  expect(TimeSplitFold.restored(throughJson(saved))?.saved()).toStrictEqual(
    saved,
  );
});

test('a time split fold saves each value with its periods in the order they began, its undated and unsplit rows, and the rest', () => {
  const fold = new TimeSplitFold('day', 'point');
  fold.add('North', '2024-03-04 14:05', '1.5');
  fold.add('North', '2024-03-04 09:00', '');
  fold.add('South', 'n/a', '-2');
  const sum = (...xs: number[]) => {
    const s = new ExactSum();
    for (const x of xs) s.add(x);
    return s.saved();
  };
  const hour = (date: string) =>
    Math.floor(readDate(date, 'day')! / HOUR_MINUTES);
  const none = { rows: 0, sum: sum() };
  expect(throughJson(fold.saved())).toStrictEqual({
    reading: 'day',
    mark: 'point',
    held: 'hour',
    groups: [
      {
        value: 'North',
        periods: [
          [hour('2024-03-04 14:00'), 1, sum(1.5)],
          [hour('2024-03-04 09:00'), 1, sum()],
        ],
        undated: none,
        unsplit: none,
      },
      {
        value: 'South',
        periods: [],
        undated: { rows: 1, sum: sum(-2) },
        unsplit: none,
      },
    ],
    rest: none,
    dates: { blank: 0, unparsed: 1, other: 0 },
    skipped: { blank: 1, unparsed: 0 },
  });
});

/** Numbers of a few figures over many decades, either side of zero. */
const SPREAD_CELLS = [...CELLS, '0', '2.3', '-2.25', '1e300', '7e-12'];
// Few enough buckets that a spread of DRAWS rows coarsens.
const SPREAD_BUCKETS = 8;

test('a spread read back from its save folds on as the fold it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = () =>
      SPREAD_CELLS[Math.floor(random() * SPREAD_CELLS.length)]!;
    const cells = Array.from({ length: DRAWS }, pick);
    for (const [mark, atMost] of [
      ['point', SPREAD_AT_MOST],
      ['comma', SPREAD_AT_MOST],
      ['point', SPREAD_BUCKETS],
    ] as const) {
      const make = () => new SpreadFold(mark, atMost);
      // An edit takes the first row back before the save, and puts it back
      // after it.
      const first = (fold: SpreadFold) => {
        for (const c of cells.slice(0, HALF)) fold.add(c);
        fold.remove(cells[0]!);
      };
      const then = (fold: SpreadFold) => {
        for (const c of cells.slice(HALF)) fold.add(c);
        fold.add(cells[0]!);
      };
      const [whole, before] = [make(), make()];
      first(whole);
      then(whole);
      first(before);
      const after = SpreadFold.restored(throughJson(before.saved()), atMost)!;
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.read(), `seed ${seed}`).toStrictEqual(whole.read());
    }
  }
});

test('a save that holds no spread reads back as none', () => {
  const fold = new SpreadFold('point', SPREAD_BUCKETS);
  for (const c of SPREAD_CELLS) fold.add(c);
  const saved = fold.saved();
  expect(saved.figures).not.toBe('exact');
  const [key, rows] = saved.buckets[1]!;
  const unsaved = [
    null,
    [],
    { ...saved, mark: 'dot' },
    { ...saved, figures: 0 },
    { ...saved, figures: 13 },
    { ...saved, buckets: [...saved.buckets, [key, rows]] },
    { ...saved, buckets: [[key, 0], ...saved.buckets.slice(2)] },
    { ...saved, buckets: [[key + 0.5, rows], ...saved.buckets.slice(2)] },
    { ...saved, buckets: [[Number.MAX_SAFE_INTEGER, rows]] },
    { ...saved, sum: { partials: [1], units: 0.5 } },
    { ...saved, skipped: { blank: -1, unparsed: 0 } },
    { ...new SpreadFold('point').saved(), buckets: [[Number.NaN, 1]] },
  ];
  for (const v of unsaved) {
    expect(SpreadFold.restored(throughJson(v), SPREAD_BUCKETS)).toBeUndefined();
  }
  expect(SpreadFold.restored(throughJson(saved), SPREAD_BUCKETS)).toBeDefined();
  // A fold that holds more buckets than its bound above one figure refolds.
  const exact = new SpreadFold('point');
  for (const c of SPREAD_CELLS) exact.add(c);
  expect(SpreadFold.restored(throughJson(exact.saved()))).toBeDefined();
  expect(SpreadFold.restored(throughJson(exact.saved()), 1)).toBeUndefined();
});

test('a spreads fold read back from its save folds on as the fold it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(random() * xs.length)]!;
    const values = ['', 'East', 'West', 'North America'];
    const rows = Array.from({ length: DRAWS }, (): [string, string] => [
      pick(values),
      pick(SPREAD_CELLS),
    ]);
    for (const mark of ['point', 'comma'] as const) {
      // An edit takes the first row back before the save, and puts it back after it.
      const first = (fold: SpreadsFold) => {
        for (const r of rows.slice(0, HALF)) fold.add(...r);
        fold.remove(...rows[0]!);
      };
      const then = (fold: SpreadsFold) => {
        for (const r of rows.slice(HALF)) fold.add(...r);
        fold.add(...rows[0]!);
      };
      const [whole, before] = [new SpreadsFold(mark), new SpreadsFold(mark)];
      first(whole);
      then(whole);
      first(before);
      const after = SpreadsFold.restored(throughJson(before.saved()))!;
      then(after);
      expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
      expect(after.snapshot(), `seed ${seed}`).toStrictEqual(whole.snapshot());
    }
  }
});

test('a save that holds no spreads fold reads back as none', () => {
  const fold = new SpreadsFold('point');
  for (const [i, c] of SPREAD_CELLS.entries()) fold.add(`v${i % 3}`, c);
  const saved = fold.saved();
  const [value, spread] = saved.values[0]!;
  const empty = new SpreadsFold('point').saved().rest;
  const crowded = Array.from({ length: BOX_VALUES_AT_MOST + 1 }, (_, i) => [
    `${i}`,
    spread,
  ]);
  const unsaved = [
    null,
    { ...saved, mark: 'dot' },
    { ...saved, values: [...saved.values, [value, spread]] },
    { ...saved, values: [[value, empty]] },
    { ...saved, values: [[1, spread]] },
    { ...saved, values: [[value, { ...spread, mark: 'comma' }]] },
    { ...saved, values: crowded },
    { ...saved, rest: { ...saved.rest, figures: 0 } },
  ];
  for (const v of unsaved)
    expect(SpreadsFold.restored(throughJson(v))).toBeUndefined();
  expect(SpreadsFold.restored(throughJson(saved))).toBeDefined();
});

/**
 * The hash of the folds TALLY_VERSION makes of the fixture: its rows by
 * region, its revenue and units summed by channel with each mark, its
 * revenue against units with each mark, and its rows and revenue over its
 * dates in each order, with DATES added, and its rows and revenue per
 * region by channel with each mark, with CELLS added, and its revenue and
 * units spread with each mark, exact and coarsened, with SPREAD_CELLS, and
 * its revenue spread by region and by rep with each mark, and its revenue
 * and units' mean by channel with each mark, with CELLS added, and a sample
 * of its units, revenue and units again with each mark, and a swarm of its
 * revenue by region with each mark. It
 * changes only with a fold or how a cell reads as a number, and with it the
 * version.
 */
const GOLDEN = {
  version: 1,
  groups: '2ae37431f8e378df8ef90b5aa4776174d479cc156f24f3a898676c88cdd7c6cd',
  sample: '82b28cba5c4ad68f0358cb3c9b9cfbe9e4aaecbb4f143ca0412395470acb6432',
  time: '2df69fd36bdc14b0210c23556d82b8f16274974e471b7d7464b59c1c25e34b15',
  split: '3ab387dbb1edb3cd98458b6895bbeecccaf155215b4003996b8682126067ba66',
  spread: 'e623684be52f441a3afae50186f5f68a0d942ccb3b267715a208bd1734956c67',
  spreads: '4d692394f8b2ad5f577c4016013a381dc2662741743816ab00b57a35dc29e6d1',
  mean: '46fe0e11379d829a37ab6ee93bbfb3c25da30cff2630076375e3aca28605c4f9',
  week: '34cedec1c28038164d7bec62b8722839122943259e473f3da14a8b2ecebcc5f1',
  timesplit: 'b9c33792e532174a66fd6d6c4da76ab4660357618dcb803a2b748b93085bd914',
  sampled: 'f3605671c11cde835fd86490d87ecacf5d3fc5d2228126629b2c1dc577b0fd99',
  swarm: 'd9d9a3ae10d466537ca13c062093e4724c7c7db3704e699758706281d9a177cf',
};

test('the folds of a fixed file are as TALLY_VERSION says', () => {
  const sheet = read('sales-q3.csv', bytes);
  const column = (col: number) =>
    Array.from({ length: sheet.rows() }, (_, r) => sheet.display(r, col));
  const [regions, channels] = [column(REGION), column(CHANNEL)];
  const folds = [new GroupsFold()];
  for (const mark of ['point', 'comma'] as const) {
    for (const col of [REVENUE, UNITS]) {
      const fold = new GroupsFold('sum', mark);
      const cells = column(col);
      channels.forEach((v, r) => fold.add(v, cells[r]));
      CELLS.forEach((cell) => fold.add('', cell));
      folds.push(fold);
    }
  }
  regions.forEach((v) => folds[0]!.add(v));
  const saved = JSON.stringify(folds.map((f) => f.saved()));
  expect(
    TALLY_VERSION,
    'a new TALLY_VERSION pins the hash its folds make with it',
  ).toBe(GOLDEN.version);
  expect(
    hashOf(encoder.encode(saved)),
    'a fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.groups);
  const [units, revenue] = [column(UNITS), column(REVENUE)];
  const samples = (['point', 'comma'] as const).map((mark) => {
    const fold = new SampleFold([mark, mark]);
    units.forEach((x, r) =>
      fold.add(Math.floor(r / BLOCK_ROWS), r, x, revenue[r]!),
    );
    return savedPoints(fold.saved());
  });
  expect(
    hashOf(encoder.encode(JSON.stringify(samples))),
    'a scatter fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.sample);
  const dates = [...column(DATE), ...DATES];
  const cells = [...revenue, ...DATES.map((_, i) => CELLS[i % CELLS.length]!)];
  const times = (['day', 'month'] as const).flatMap((order) => [
    new TimeFold(order),
    new TimeFold(order, 'point'),
    new TimeFold(order, 'comma'),
  ]);
  for (const fold of times) dates.forEach((v, r) => fold.add(v, cells[r]));
  expect(
    hashOf(encoder.encode(JSON.stringify(times.map((f) => f.saved())))),
    'a time fold, or how a cell reads as a date or a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.time);
  const splits = [
    new SplitFold(),
    new SplitFold('point'),
    new SplitFold('comma'),
  ];
  for (const fold of splits) {
    regions.forEach((v, r) => fold.add(v, channels[r]!, revenue[r]));
    CELLS.forEach((cell) => fold.add('', '', cell));
  }
  expect(
    hashOf(encoder.encode(JSON.stringify(splits.map((f) => f.saved())))),
    'a split fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.split);
  const spreads = (['point', 'comma'] as const).flatMap((mark) =>
    [REVENUE, UNITS].flatMap((col) =>
      [undefined, SPREAD_BUCKETS].map((atMost) => {
        const fold = new SpreadFold(mark, atMost);
        for (const c of [...column(col), ...SPREAD_CELLS]) fold.add(c);
        return fold.saved();
      }),
    ),
  );
  expect(
    hashOf(encoder.encode(JSON.stringify(spreads))),
    'a spread, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.spread);
  const reps = column(REP);
  const byValue = (['point', 'comma'] as const).flatMap((mark) =>
    [regions, reps].map((by) => {
      const fold = new SpreadsFold(mark);
      by.forEach((v, r) => fold.add(v, revenue[r]!));
      return fold.saved();
    }),
  );
  expect(
    hashOf(encoder.encode(JSON.stringify(byValue))),
    'a spreads fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.spreads);
  const means = (['point', 'comma'] as const).flatMap((mark) =>
    [REVENUE, UNITS].map((col) => {
      const fold = new GroupsFold('mean', mark);
      const cells = column(col);
      channels.forEach((v, r) => fold.add(v, cells[r]));
      CELLS.forEach((cell) => fold.add('', cell));
      return fold.saved();
    }),
  );
  expect(
    hashOf(encoder.encode(JSON.stringify(means))),
    'a mean fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.mean);
  const weeks = (['day', 'month'] as const).flatMap((order) => [
    new WeekFold(order),
    new WeekFold(order, 'point'),
    new WeekFold(order, 'comma'),
  ]);
  for (const fold of weeks) dates.forEach((v, r) => fold.add(v, cells[r]));
  expect(
    hashOf(encoder.encode(JSON.stringify(weeks.map((f) => f.saved())))),
    'a week fold, or how a cell reads as a date or a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.week);
  const timeSplits = (['day', 'month'] as const).flatMap((order) => [
    new TimeSplitFold(order),
    new TimeSplitFold(order, 'point'),
    new TimeSplitFold(order, 'comma'),
  ]);
  for (const fold of timeSplits) {
    dates.forEach((v, r) =>
      fold.add(regions[r % regions.length]!, v, cells[r]),
    );
  }
  expect(
    hashOf(encoder.encode(JSON.stringify(timeSplits.map((f) => f.saved())))),
    'a time split fold, or how a cell reads as a date or a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.timesplit);
  const sampled = (['point', 'comma'] as const).map((mark) => {
    const fold = new SampleFold([mark, mark, mark]);
    units.forEach((u, r) =>
      fold.add(Math.floor(r / BLOCK_ROWS), r, u, revenue[r]!, u),
    );
    return fold.saved();
  });
  expect(
    hashOf(encoder.encode(JSON.stringify(sampled))),
    'a sample fold of three columns, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.sampled);
  const swarms = (['point', 'comma'] as const).map((mark) => {
    const fold = new SwarmFold(mark);
    revenue.forEach((cell, r) =>
      fold.add(Math.floor(r / BLOCK_ROWS), r, regions[r]!, cell),
    );
    return fold.saved();
  });
  expect(
    hashOf(encoder.encode(JSON.stringify(swarms))),
    'a swarm fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.swarm);
});
