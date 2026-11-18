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
  HELD_AT_MOST,
  SampleFold,
  SplitFold,
  TALLY_VERSION,
  TimeFold,
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
// The fixture's first column, its dates.
const DATE = 0;
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

test('a split fold saves each count in the order it began, with its exact sum', () => {
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
          ['web', 2, sum(1.5)],
          ['direct', 1, none],
        ],
        unsplit: { rows: 0, sum: none },
      },
      {
        value: 'West',
        cells: [['web', 1, sum(-2)]],
        unsplit: { rows: 0, sum: none },
      },
    ],
    rest: { rows: 0, sum: none },
    totals: [
      ['web', 3, sum(1.5, -2)],
      ['direct', 1, none],
    ],
    totalsRest: { rows: 0, sum: none },
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

test('a scatter fold read back from its save folds on as the fold it was', () => {
  const half = (PAGE_BLOCKS + 1) * BLOCK_ROWS;
  const before = scattered(range(0, half));
  const after = scattered(
    range(half, PAGED_ROWS),
    SampleFold.restored(throughJson(before.saved())),
  );
  const whole = scattered(range(0, PAGED_ROWS));
  expect(after.snapshot()).toStrictEqual(whole.snapshot());
  expect(after.stale()).toEqual([]);
});

test("an edit of a read back page's least or most folds each of its blocks again", () => {
  const rows = range(0, PAGED_ROWS);
  const page = scattered(rows).saved().pages[1]!;
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
  const fold = SampleFold.restored(throughJson(scattered(rows).saved()))!;
  const whole = scattered(rows);
  expect(mended(fold, inside)).toEqual([]);
  expect(mended(fold, top)).toEqual(range(page.first, page.first + page.span));
  mended(whole, inside);
  expect(mended(whole, top)).toEqual([Math.floor(top / BLOCK_ROWS)]);
  expect(fold.snapshot()).toStrictEqual(whole.snapshot());
});

test('a read back page gives a block back to fold again whole, and leaves no block stale', () => {
  const rows = range(0, PAGED_ROWS);
  const fold = SampleFold.restored(throughJson(scattered(rows).saved()))!;
  const block = PAGE_BLOCKS + 1;
  const alone = range(block * BLOCK_ROWS, (block + 1) * BLOCK_ROWS);
  for (const row of alone) fold.forget(row, ...paged(row));
  fold.refold(block, new SampleFold(POINTS));
  expect(fold.stale()).toEqual([]);
  scattered(alone, fold);
  expect(fold.snapshot()).toStrictEqual(scattered(rows).snapshot());
});

test('a save that holds no scatter fold reads back as none', () => {
  const saved = scattered(range(0, BLOCK_ROWS)).saved();
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
  for (const v of unsaved) expect(SampleFold.restored(v)).toBeUndefined();
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

/**
 * The hash of the folds TALLY_VERSION makes of the fixture: its rows by
 * region, its revenue and units summed by channel with each mark, its
 * revenue against units with each mark, and its rows and revenue over its
 * dates in each order, with DATES added, and its rows and revenue per
 * region by channel with each mark, with CELLS added. It
 * changes only with a fold or how a cell reads as a number, and with it the
 * version.
 */
const GOLDEN = {
  version: 1,
  groups: '2ae37431f8e378df8ef90b5aa4776174d479cc156f24f3a898676c88cdd7c6cd',
  sample: '82b28cba5c4ad68f0358cb3c9b9cfbe9e4aaecbb4f143ca0412395470acb6432',
  time: '2df69fd36bdc14b0210c23556d82b8f16274974e471b7d7464b59c1c25e34b15',
  split: '10134ed7db0713a75f0bbebee410afa91ef190bbc0d7ef23fed72bf12fd9191c',
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
});
