/**
 * @fileoverview A chart's record: what the codec reads of one, and how it
 * names a field it refuses.
 */

import { describe, expect, test } from 'vite-plus/test';

import { REFRESH_MINUTES_AT_MOST, TITLE_AT_MOST, parseChart } from '@document';
import type { Chart, Plot } from '@document';
import { parsePlot } from '@document/codec';

const WHERE = 'books.uno: view/charts.json: chart 1 of 1';
const PLOT = `${WHERE} (c1): plot`;

const REGION = { col: 1, header: 'region' };
const REVENUE = { col: 4, header: 'revenue' };
const UNITS = { col: 5, header: 'units' };
const NO_HEADER = { col: 0, header: '' };

/** Revenue per region, with the longest title and wait. */
const BARS: Chart = {
  id: 'c1',
  source: 'sales',
  plot: { t: 'bars', by: REGION, sum: REVENUE },
  title: 'r'.repeat(TITLE_AT_MOST),
  refresh: REFRESH_MINUTES_AT_MOST,
};

const NOT_TITLE = `title is not text of at most ${TITLE_AT_MOST} characters`;
const NOT_MINUTES = `refresh is not a whole number of minutes from 0 to ${REFRESH_MINUTES_AT_MOST}`;

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

describe('parseChart', () => {
  test('reads a chart at its limits, and leaves out a key it does not know', () => {
    expect(parseChart(WHERE, { ...BARS, colour: 'teal' })).toStrictEqual(BARS);
  });

  test('refuses a chart with no id, naming where it is', () => {
    expect(() => parseChart(WHERE, { ...BARS, id: '' })).toThrow(
      new Error(`${WHERE}: id is empty or not text`),
    );
  });

  test.each<[string, unknown, string]>([
    ['source', '', 'source is empty or not text'],
    ['plot', { t: 'line' }, 'plot: this build cannot draw "line"'],
    ['title', `${BARS.title}r`, NOT_TITLE],
    ['refresh', -1, NOT_MINUTES],
    ['refresh', 1.5, NOT_MINUTES],
    ['refresh', REFRESH_MINUTES_AT_MOST + 1, NOT_MINUTES],
  ])('refuses %s %o, naming the chart and the key', (key, value, said) => {
    expect(() => parseChart(WHERE, { ...BARS, [key]: value })).toThrow(
      new Error(`${WHERE} (c1): ${said}`),
    );
  });
});
