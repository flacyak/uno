/**
 * @fileoverview A heatmap over periods' folder: rows per value and period of
 * the sales sheet, a block at a time, moved by an edit, and read back from
 * its save only with the reading it folded with.
 */

import { expect, test } from 'vite-plus/test';

import type { HeatPlot, Plot } from '@document';
import { timeSplitFolder } from '@engine/fold/timesplit';
import type { Folder } from '@engine/fold/index';
import { read } from '@ingest';
import { TimeSplitFold } from '@tally';
import { REGION, REVENUE, bytes } from '@core-tests/testdata/sales-q3';

const sheet = read('sales-q3.csv', bytes);
const HEADERS = ['date', 'region', 'rep', 'channel', 'units', 'revenue'];
const MARKS = HEADERS.map(() => 'point' as const);
const ROWS = sheet.rows();
const DATES = 0;
const BLOCK_ROWS = 500;
const COVERAGE = { rows: ROWS, total: ROWS, complete: true };
const column = (col: number) => ({ col, header: HEADERS[col]! });
const PLOT: HeatPlot = {
  t: 'heat',
  by: column(REGION),
  at: column(DATES),
  sum: column(REVENUE),
  per: 'month',
  order: 'day',
};
const shown = (col: number) => (row: number) => sheet.display(row, col);
/** The plot a tally names: an over-time chart's of the same size, until a heatmap is a plot. */
const SERVED: Plot = {
  t: 'time',
  at: column(DATES),
  per: 'month',
  order: 'day',
};

/** folded is `plot`'s folder over every row of the sheet, a block at a time. */
function folded(plot: HeatPlot): Folder {
  const folder = timeSplitFolder(plot, HEADERS, MARKS) as Folder;
  for (let from = 0; from < ROWS; from += BLOCK_ROWS) {
    folder.fold(from / BLOCK_ROWS, {
      from,
      end: Math.min(from + BLOCK_ROWS, ROWS),
      shown,
    });
  }
  return folder;
}

/** pure is a time split fold of every row, as PLOT reads it. */
function pure(): TimeSplitFold {
  const fold = new TimeSplitFold('day', 'point');
  for (let r = 0; r < ROWS; r++) {
    fold.add(
      sheet.display(r, REGION),
      sheet.display(r, DATES),
      sheet.display(r, REVENUE),
    );
  }
  return fold;
}

test("a heatmap's folder reads as a time split fold of every row, at the plot's size", () => {
  const folder = folded(PLOT);
  expect(folder.key).toBe(`timesplit ${REGION} ${DATES} day ${REVENUE}`);
  expect(folder.cols).toStrictEqual([REGION, DATES, REVENUE]);
  expect(folder.tally(SERVED, COVERAGE)).toStrictEqual({
    t: 'heat',
    plot: SERVED,
    coverage: COVERAGE,
    ...pure().snapshot('month'),
  });
  const weekly: Plot = { ...SERVED, per: 'week' };
  expect(folder.tally(weekly, COVERAGE)).toMatchObject(pure().snapshot('week'));
});

test("a heatmap's folder moves by an edit, and reads back from its save only with its reading", () => {
  const folder = folded(PLOT);
  const before = HEADERS.map((_, c) => sheet.display(0, c));
  const after = before.map((v, c) => (c === DATES ? '2026-09-30' : v));
  folder.move(0, 0, before, after);
  const fold = pure();
  fold.remove(before[REGION]!, before[DATES]!, before[REVENUE]!);
  fold.add(after[REGION]!, after[DATES]!, after[REVENUE]!);
  expect(folder.saved()).toStrictEqual(fold.saved());
  const saved = JSON.parse(JSON.stringify(folder.saved()));
  expect(folder.restored(saved)?.saved()).toStrictEqual(fold.saved());
  const month = timeSplitFolder(
    { ...PLOT, order: 'month' },
    HEADERS,
    MARKS,
  ) as Folder;
  expect(month.restored(saved)).toBeUndefined();
  expect(
    timeSplitFolder(
      { ...PLOT, by: { col: REGION, header: 'gone' } },
      ['date'],
      MARKS,
    ),
  ).toBe('gone');
});
