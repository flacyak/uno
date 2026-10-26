/**
 * @fileoverview SampleFold against its rows read again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { TUNING } from '@engine/rows';
import { read } from '@ingest';
import { parse } from '@num';
import { byRank } from '@tally/rank';
import { SCATTER_POINTS_AT_MOST, SampleFold } from '@tally/sample';
import { seeded, shuffled } from '@core-tests/lab/cache/stats';
import { REVENUE, UNITS, bytes } from '@core-tests/testdata/sales-q3';

/** A row's x cell and y cell. */
type Row = [string, string];

// Enough rows that a fold cuts its kept rows down more than once, in blocks
// as the engine cuts them.
const ROWS = 5 * SCATTER_POINTS_AT_MOST;
const BLOCK_ROWS = TUNING.blockRows;
const BLOCKS = ROWS / BLOCK_ROWS;
// Enough seeds that 60 blocks are each cut in two at a random row.
const SEEDS = 3;
// One row in this many has a blank y.
const BLANK_EVERY = 3;

/** blockOf returns the block that holds `row`. */
function blockOf(row: number): number {
  return Math.floor(row / BLOCK_ROWS);
}

/** rowsOf returns the rows of `blocks`, block by block. */
function rowsOf(blocks: number[]): number[] {
  const offsets = [...Array(BLOCK_ROWS).keys()];
  return blocks.flatMap((block) => offsets.map((i) => block * BLOCK_ROWS + i));
}

/** folded folds `rows` in the order `order` gives. */
function folded(rows: Row[], order = [...rows.keys()]): SampleFold {
  const fold = new SampleFold();
  for (const row of order) fold.add(blockOf(row), row, ...rows[row]!);
  return fold;
}

/** line returns rows whose y is twice their x, the row's number. */
function line(): Row[] {
  return Array.from({ length: ROWS }, (_, r): Row => [`${r}`, `${2 * r}`]);
}

/** edit takes back a row's cells and folds its new ones, as an edit does. */
function edit(fold: SampleFold, rows: Row[], row: number, to: Row): void {
  fold.remove(blockOf(row), row, ...rows[row]!);
  rows[row] = to;
  fold.add(blockOf(row), row, ...to);
}

test('a sample fold sends the points of the rows of least rank', () => {
  // A row's y is twice its x, or blank.
  const y = (r: number) => (r % BLANK_EVERY === 0 ? '' : `${2 * r}`);
  const ranked = [...Array(ROWS).keys()].sort(byRank);
  const fold = new SampleFold();
  for (let r = 0; r < ROWS; r++) fold.add(blockOf(r), r, `${r}`, y(r));
  // A row left out keeps its place in the sample, with no point.
  const sampled = ranked.slice(0, SCATTER_POINTS_AT_MOST);
  const x = sampled.filter((r) => y(r) !== '');
  expect(fold.snapshot()).toMatchObject({ x, y: x.map((r) => 2 * r) });
  // Rows that all read as numbers fill the sample, whatever their order.
  const full = new SampleFold();
  for (const r of ranked) full.add(blockOf(r), r, `${r}`, `${r}`);
  expect(full.snapshot().x).toHaveLength(SCATTER_POINTS_AT_MOST);
});

test('a sample fold reads the same block by block, in any order', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
    const cell = () => pick([`${random()}`, `${-random()}`, '', 'n/a']);
    const rows = Array.from({ length: ROWS }, (): Row => [cell(), cell()]);
    const blocks = [...Array(BLOCKS).keys()];
    const whole = folded(rows).snapshot();
    const merged = new SampleFold();
    for (const block of shuffled(blocks, random)) {
      // A block can come as two folds, cut at any row.
      const own = rowsOf([block]);
      const cut = Math.floor(random() * BLOCK_ROWS);
      merged.merge(folded(rows, own.slice(0, cut)));
      merged.merge(folded(rows, own.slice(cut)));
    }
    expect(merged.snapshot(), `seed ${seed}`).toEqual(whole);
    const order = rowsOf(shuffled(blocks, random));
    expect(folded(rows, order).snapshot()).toEqual(whole);
    // A row with a word in either cell is not a number, else it is blank.
    const out = rows.filter((row) => row.some((c) => parse(c) === undefined));
    const words = out.filter((row) => row.includes('n/a')).length;
    expect(whole.plotted).toBe(ROWS - out.length);
    expect(whole.skipped).toEqual({
      blank: out.length - words,
      unparsed: words,
    });
  }
});

test('a sample fold of revenue against units reads the sales sheet', () => {
  const sheet = read('sales-q3.csv', bytes);
  const rows = Array.from({ length: sheet.rows() }, (_, r): Row => [
    sheet.display(r, UNITS),
    sheet.display(r, REVENUE),
  ]);
  const sample = folded(rows).snapshot();
  // Four rows are blank, and three of them rank among the first 4,096.
  expect(sample.x).toHaveLength(SCATTER_POINTS_AT_MOST - 3);
  expect(sample.plotted).toBe(4808);
  expect(sample.skipped).toEqual({ blank: 4, unparsed: 0 });
  expect(sample.least).toEqual({ x: 180, y: 7200 });
  expect(sample.most).toEqual({ x: 2600, y: 104000 });
  // A fold with nothing plotted reads its least and most as 0.
  const none = new SampleFold().snapshot();
  expect(none).toMatchObject({ least: { x: 0, y: 0 }, most: { x: 0, y: 0 } });
});

test('an edit inside the sample moves one point, and one outside none', () => {
  const rows = line();
  const ranked = [...rows.keys()].sort(byRank);
  // In rank order, a fold cuts its kept rows at the last row it samples.
  const fold = folded(rows, ranked);
  const { x, y } = fold.snapshot();
  edit(fold, rows, ranked[SCATTER_POINTS_AT_MOST - 1]!, ['0.5', '0.5']);
  edit(fold, rows, ranked.at(-1)!, [`${ROWS}`, '-1']);
  edit(fold, rows, ranked.at(-2)!, ['', '1']);
  edit(fold, rows, ranked.at(-2)!, ['n/a', '1']);
  expect(fold.snapshot()).toEqual({
    x: [...x.slice(0, -1), 0.5],
    y: [...y.slice(0, -1), 0.5],
    plotted: ROWS - 1,
    least: { x: 0, y: -1 },
    most: { x: ROWS, y: 2 * (ROWS - 1) },
    skipped: { blank: 0, unparsed: 1 },
  });
});
