/**
 * @fileoverview SampleFold against its rows read again from scratch.
 */

import { expect, test } from 'vite-plus/test';

import { TUNING } from '@engine/rows';
import { byRank } from '@tally/rank';
import { SCATTER_POINTS_AT_MOST, SampleFold } from '@tally/sample';
import { seeded, shuffled } from '@core-tests/lab/cache/stats';

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

/** rowsOf returns the rows of `blocks`, block by block. */
function rowsOf(blocks: number[]): number[] {
  const offsets = [...Array(BLOCK_ROWS).keys()];
  return blocks.flatMap((block) => offsets.map((i) => block * BLOCK_ROWS + i));
}

/** folded folds `rows` in the order `order` gives. */
function folded(rows: Row[], order = [...rows.keys()]): SampleFold {
  const fold = new SampleFold();
  for (const row of order) fold.add(row, ...rows[row]!);
  return fold;
}

test('a sample fold sends the points of the rows of least rank', () => {
  // A row's y is twice its x, or blank.
  const y = (r: number) => (r % BLANK_EVERY === 0 ? '' : `${2 * r}`);
  const ranked = [...Array(ROWS).keys()].sort(byRank);
  const fold = new SampleFold();
  for (let r = 0; r < ROWS; r++) fold.add(r, `${r}`, y(r));
  // A row left out keeps its place in the sample, with no point.
  const sampled = ranked.slice(0, SCATTER_POINTS_AT_MOST);
  const x = sampled.filter((r) => y(r) !== '');
  expect(fold.snapshot()).toMatchObject({ x, y: x.map((r) => 2 * r) });
  // Rows that all read as numbers fill the sample, whatever their order.
  const full = new SampleFold();
  for (const r of ranked) full.add(r, `${r}`, `${r}`);
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
  }
});
