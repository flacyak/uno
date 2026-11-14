/**
 * @fileoverview A fold a save wrote reads back as the fold it was, bit for
 * bit, so rows added after the reopen fold as they would have into the fold
 * before it, and the folds of a fixed file are pinned to TALLY_VERSION.
 */

import { expect, test } from 'vite-plus/test';

import { hashOf } from '@engine/grown';
import { read } from '@ingest';
import {
  DISTINCT_AT_MOST,
  ExactSum,
  GroupsFold,
  SampleFold,
  TALLY_VERSION,
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

/** Blocks a page of a scatter's least and most holds, and rows a block. */
const PAGE_BLOCKS = 256;
const BLOCK_ROWS = 4;
/** Rows over two pages and a part of a third. */
const PAGED_ROWS = (2 * PAGE_BLOCKS + 3) * BLOCK_ROWS;
const POINTS = { x: 'point', y: 'point' } as const;

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
  const saved = fold.saved();
  expect(throughJson(saved)).toEqual(saved);
  expect(saved.pages.map(({ first, span }) => [first, span])).toEqual([
    [0, PAGE_BLOCKS],
    [PAGE_BLOCKS, PAGE_BLOCKS],
    [2 * PAGE_BLOCKS, 3],
  ]);
  // Each page's least and most are those of its rows alone.
  for (const { first, span, least, most } of saved.pages) {
    const rows = range(first * BLOCK_ROWS, (first + span) * BLOCK_ROWS);
    const alone = scattered(rows).snapshot();
    expect({ least, most }).toEqual({ least: alone.least, most: alone.most });
  }
  expect(saved.kept.length).toBeGreaterThan(0);
  expect(saved.plotted).toBe(fold.snapshot().plotted);
});

/**
 * The hash of the folds TALLY_VERSION makes of the fixture: its rows by
 * region, its revenue and units summed by channel with each mark, and its
 * revenue against units with each mark. It
 * changes only with a fold or how a cell reads as a number, and with it the
 * version.
 */
const GOLDEN = {
  version: 1,
  groups: '2ae37431f8e378df8ef90b5aa4776174d479cc156f24f3a898676c88cdd7c6cd',
  sample: '82b28cba5c4ad68f0358cb3c9b9cfbe9e4aaecbb4f143ca0412395470acb6432',
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
    const fold = new SampleFold({ x: mark, y: mark });
    units.forEach((x, r) =>
      fold.add(Math.floor(r / BLOCK_ROWS), r, x, revenue[r]!),
    );
    return fold.saved();
  });
  expect(
    hashOf(encoder.encode(JSON.stringify(samples))),
    'a scatter fold, or how a cell reads as a number, holds otherwise for the same cells: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.sample);
});
