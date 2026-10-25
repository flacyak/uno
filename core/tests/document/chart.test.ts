/**
 * @fileoverview A chart's record: what the codec reads of one, and how it
 * names a field it refuses.
 */

import { describe, expect, test } from 'vite-plus/test';

import type { Plot } from '@document';
import { parsePlot } from '@document/codec';

const PLOT = 'books.uno: view/charts.json: chart 1 of 1 (c1): plot';

const REGION = { col: 1, header: 'region' };
const REVENUE = { col: 4, header: 'revenue' };
const UNITS = { col: 5, header: 'units' };
const NO_HEADER = { col: 0, header: '' };

describe('parsePlot', () => {
  test.each<Plot>([
    { t: 'bars', by: REGION, sum: REVENUE },
    { t: 'pie', by: NO_HEADER },
    { t: 'scatter', x: REVENUE, y: UNITS },
  ])('reads %j, and leaves out a key it does not know', (plot) => {
    expect(parsePlot(PLOT, { ...plot, colour: 'teal' })).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'line', by: REGION }, 'this build cannot draw "line"'],
    [{ t: 'pie' }, 'by: col is not a column number'],
    [{ t: 'bars', by: { col: -1 } }, 'by: col is not a column number'],
    [{ t: 'pie', by: REGION, sum: { col: 4 } }, 'sum: header is not text'],
    [{ t: 'scatter', x: REVENUE }, 'y: col is not a column number'],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parsePlot(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});
