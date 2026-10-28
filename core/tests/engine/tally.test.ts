/**
 * @fileoverview The engine tallies a source's charts behind the index: a
 * chart reads the columns its plot names, found by header where the file
 * moved them, and folds each block from the first it lacks.
 */

import { expect, test } from 'vite-plus/test';

import type { Chart } from '@document';
import { Tallies } from '@engine/tally';
import { REGION, REVENUE, ROWS } from '@core-tests/testdata/sales-q3';
import { TINY, sales } from './harness.ts';

const SOURCE = 'sales';
const HEADERS = sales.columns.map((c) => c.header);
/** The fixture's column `col`, as a chart names it. */
const column = (col: number) => ({ col, header: HEADERS[col]! });

/** Rows per region, placed as a save writes a new chart. */
const REGION_ROWS: Chart = {
  id: 'c1',
  source: SOURCE,
  plot: { t: 'bars', by: column(REGION) },
  title: '',
  place: { x: 1, y: 0, width: 420, height: 260 },
  refresh: 0,
};

/** folded attaches `charts` and folds the sheet, a TINY block at a time. */
function folded(charts: Chart[]): Tallies {
  const tallies = new Tallies();
  for (const chart of charts) tallies.attach(chart, HEADERS);
  const shown = (col: number) => (row: number) => sales.display(row, col);
  for (let from = 0; from < ROWS; from += TINY.blockRows) {
    const end = Math.min(from + TINY.blockRows, ROWS);
    tallies.fold(from / TINY.blockRows, from, end, shown);
  }
  return tallies;
}

test("a chart's column is found where it was, or by its header where the file moved it, and one the file has not names itself", () => {
  const tallies = new Tallies();
  expect(tallies.attach(REGION_ROWS, HEADERS)).toBeUndefined();
  const region = { col: REVENUE, header: 'region' };
  const moved: Chart = { ...REGION_ROWS, plot: { t: 'bars', by: region } };
  expect(tallies.attach(moved, HEADERS)).toBeUndefined();
  const margin = { col: REGION, header: 'margin' };
  const gone: Chart = { ...REGION_ROWS, plot: { t: 'pie', by: margin } };
  expect(tallies.attach(gone, HEADERS)).toBe('margin');
});

test('a chart folds each block from the first it lacks, and one attached later lacks them all', () => {
  const tallies = folded([REGION_ROWS]);
  expect(tallies.from()).toBe(ROWS);
  tallies.attach({ ...REGION_ROWS, id: 'c2' }, HEADERS);
  expect(tallies.from()).toBe(0);
  tallies.detach('c2');
  expect(tallies.from()).toBe(ROWS);
});
