/**
 * @fileoverview The engine tallies a source's charts behind the index: a
 * chart reads the columns its plot names, found by header where the file
 * moved them.
 */

import { expect, test } from 'vite-plus/test';

import type { Chart } from '@document';
import { Tallies } from '@engine/tally';
import { REGION, REVENUE } from '@core-tests/testdata/sales-q3';
import { sales } from './harness.ts';

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
