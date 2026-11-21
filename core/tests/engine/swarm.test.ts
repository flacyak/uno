/**
 * @fileoverview A beeswarm's folder: a sample of each region's revenue in the
 * sales sheet, a block at a time, moved by an edit, mended, and read back from
 * its save only with the mark it folded with.
 */

import { expect, test } from 'vite-plus/test';

import type { Plot, SwarmPlot } from '@document';
import { swarmFolder } from '@engine/fold/swarm';
import type { Folder } from '@engine/fold/index';
import { read } from '@ingest';
import { SwarmFold } from '@tally';
import { REGION, REVENUE, bytes } from '@core-tests/testdata/sales-q3';

const sheet = read('sales-q3.csv', bytes);
const HEADERS = ['date', 'region', 'rep', 'channel', 'units', 'revenue'];
const MARKS = HEADERS.map(() => 'point' as const);
const ROWS = sheet.rows();
const BLOCK_ROWS = 500;
const COVERAGE = { rows: ROWS, total: ROWS, complete: true };
const column = (col: number) => ({ col, header: HEADERS[col]! });
const PLOT: SwarmPlot = { t: 'swarm', of: column(REVENUE), by: column(REGION) };
/** The plot a tally names: a box plot of the same columns, until a beeswarm is a plot. */
const SERVED: Plot = { t: 'box', of: PLOT.of, by: PLOT.by!, span: 'all' };
const shown = (col: number) => (row: number) => sheet.display(row, col);
const blockOf = (row: number) => Math.floor(row / BLOCK_ROWS);
const rowsOf = (block: number) => ({
  from: block * BLOCK_ROWS,
  end: Math.min((block + 1) * BLOCK_ROWS, ROWS),
  shown,
});

/** folded is `plot`'s folder over every row of the sheet, a block at a time. */
function folded(plot: SwarmPlot): Folder {
  const folder = swarmFolder(plot, HEADERS, MARKS) as Folder;
  for (let block = 0; block * BLOCK_ROWS < ROWS; block++) {
    folder.fold(block, rowsOf(block));
  }
  return folder;
}

/** pure is a swarm fold of every row, by region or as one value. */
function pure(by = true): SwarmFold {
  const fold = new SwarmFold('point');
  for (let r = 0; r < ROWS; r++) {
    const value = by ? sheet.display(r, REGION) : '';
    fold.add(blockOf(r), r, value, sheet.display(r, REVENUE));
  }
  return fold;
}

test("a beeswarm's folder reads as a swarm fold of every row, by its values or as one", () => {
  const folder = folded(PLOT);
  expect(folder.key).toBe(`swarm ${REVENUE} ${REGION}`);
  expect(folder.cols).toStrictEqual([REVENUE, REGION]);
  expect(folder.tally(SERVED, COVERAGE)).toStrictEqual({
    t: 'swarm',
    plot: SERVED,
    coverage: COVERAGE,
    ...pure().snapshot(),
  });
  const alone: SwarmPlot = { t: 'swarm', of: column(REVENUE) };
  const one = folded(alone);
  expect([one.key, one.cols]).toStrictEqual([`swarm ${REVENUE}`, [REVENUE]]);
  expect(one.tally(SERVED, COVERAGE)).toMatchObject(pure(false).snapshot());
});

test("a beeswarm's folder moves by an edit, mends the block it took a least from, and reads back from its save only with its mark", () => {
  const folder = folded(PLOT);
  const fold = pure();
  const before = HEADERS.map((_, c) => sheet.display(0, c));
  const after = before.map((v, c) => (c === REVENUE ? '-1' : v));
  folder.move(0, 0, before, after);
  fold.remove(0, 0, before[REGION]!, before[REVENUE]!);
  fold.add(0, 0, after[REGION]!, after[REVENUE]!);
  expect(folder.tally(SERVED, COVERAGE)).toMatchObject({
    ...fold.snapshot(),
    least: -1,
  });
  // Taking -1 back leaves its block stale, which a save leaves out until mended.
  folder.move(0, 0, after, before);
  expect(folder.saved()).toBeUndefined();
  return folder
    .mend(async (block) => rowsOf(block))
    .then(() => {
      expect(folder.saved()).toStrictEqual(pure().saved());
      const saved = JSON.parse(JSON.stringify(folder.saved()));
      expect(folder.restored(saved)?.saved()).toStrictEqual(pure().saved());
      const comma = swarmFolder(
        PLOT,
        HEADERS,
        HEADERS.map(() => 'comma' as const),
      ) as Folder;
      expect(comma.restored(saved)).toBeUndefined();
      expect(
        swarmFolder(
          { ...PLOT, by: { col: REGION, header: 'gone' } },
          ['revenue'],
          MARKS,
        ),
      ).toBe('gone');
    });
});
