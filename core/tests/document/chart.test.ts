/**
 * @fileoverview A chart's record: what the codec reads of one, and how it
 * names a field it refuses.
 */

import { describe, expect, test } from 'vite-plus/test';

import { REFRESH_MINUTES_AT_MOST, TITLE_AT_MOST, parseChart } from '@document';
import type { Chart, Plot, StackPlot, TimePlot } from '@document';
import { parseOverTime, parsePlot, parseStacked } from '@document/codec';
import { GROUPS_SENT } from '@tally';

const WHERE = 'books.uno: view/charts.json: chart 1 of 1';
const PLOT = `${WHERE} (c1): plot`;

const REGION = { col: 1, header: 'region' };
const REVENUE = { col: 4, header: 'revenue' };
const UNITS = { col: 5, header: 'units' };
const NO_HEADER = { col: 0, header: '' };
const DATE = { col: 0, header: 'date' };
const PERS = 'hour, day, week, month, quarter, year, auto';
const ONE_READING = 'order or unit, one of the two, says how dates read';
const PLACE = { x: 1, y: 0, width: 420, height: 260 };

/** Revenue per region at the right edge, with the longest title and wait. */
const BARS: Chart = {
  id: 'c1',
  source: 'sales',
  plot: { t: 'bars', by: REGION, sum: REVENUE },
  title: 'r'.repeat(TITLE_AT_MOST),
  place: PLACE,
  refresh: REFRESH_MINUTES_AT_MOST,
};

const NOT_TITLE = `title is not text of at most ${TITLE_AT_MOST} characters`;
const NOT_MINUTES = `refresh is not a whole number of minutes from 0 to ${REFRESH_MINUTES_AT_MOST}`;
const NOT_SIZE = 'is not a size of at least 1 px';

describe('parsePlot', () => {
  test.each<Plot>([
    { t: 'bars', by: REGION, sum: REVENUE },
    { t: 'pie', by: NO_HEADER },
    { t: 'scatter', x: REVENUE, y: UNITS },
    { t: 'time', at: DATE, sum: REVENUE, per: 'week', unit: 's' },
    { t: 'histogram', of: REVENUE, span: 'most' },
    { t: 'histogram', of: UNITS, span: 'all' },
  ])('reads %j', (plot) => {
    expect(parsePlot(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'line', by: REGION }, 'this build cannot draw "line"'],
    [{ t: 'pie' }, 'by: col is not a column number'],
    [{ t: 'bars', by: { col: -1 } }, 'by: col is not a column number'],
    [{ t: 'pie', by: REGION, sum: { col: 4 } }, 'sum: header is not text'],
    [{ t: 'scatter', x: REVENUE }, 'y: col is not a column number'],
    [
      { t: 'bars', by: REGION, colour: 'teal' },
      'this build does not read "colour"',
    ],
    [{ t: 'pie', by: REGION, x: REVENUE }, 'this build does not read "x"'],
    [
      { t: 'scatter', x: REVENUE, y: UNITS, by: REGION },
      'this build does not read "by"',
    ],
    [
      { t: 'time', at: DATE, per: 'day', order: 'day', by: REGION },
      'this build does not read "by"',
    ],
    [{ t: 'time', at: DATE, per: 'day' }, ONE_READING],
    [{ t: 'histogram', of: REVENUE }, 'span is not most or all'],
    [{ t: 'histogram', of: REVENUE, span: 'some' }, 'span is not most or all'],
    [
      { t: 'histogram', of: REVENUE, span: 'all', by: REGION },
      'this build does not read "by"',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parsePlot(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});

describe('a moved bar', () => {
  const MOVED = `order is not at most ${GROUPS_SENT} values of text, each once`;

  test.each<Plot>([
    { t: 'bars', by: REGION, order: ['West', ''] },
    { t: 'bars', by: REGION, sum: REVENUE, order: [] },
    { t: 'stack', by: REGION, split: UNITS, order: ['North'] },
  ])('reads %j', (plot) => {
    expect(parsePlot(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'bars', by: REGION, order: 'West' }, MOVED],
    [{ t: 'bars', by: REGION, order: ['West', 'West'] }, MOVED],
    [{ t: 'bars', by: REGION, order: [1] }, MOVED],
    [
      {
        t: 'bars',
        by: REGION,
        order: Array.from({ length: GROUPS_SENT + 1 }, (_, i) => `${i}`),
      },
      MOVED,
    ],
    [
      { t: 'pie', by: REGION, order: ['West'] },
      'this build does not read "order"',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parsePlot(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});

describe('parseOverTime', () => {
  test.each<TimePlot>([
    { t: 'time', at: DATE, per: 'auto', order: 'month' },
    { t: 'time', at: DATE, sum: REVENUE, per: 'quarter', order: 'day' },
    { t: 'time', at: DATE, per: 'hour', unit: 'ms' },
  ])('reads %j', (plot) => {
    expect(parseOverTime(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'time', per: 'day', order: 'day' }, 'at: col is not a column number'],
    [{ t: 'time', at: DATE, order: 'day' }, `per is not one of ${PERS}`],
    [
      { t: 'time', at: DATE, per: 'fortnight', order: 'day' },
      `per is not one of ${PERS}`,
    ],
    [
      { t: 'time', at: DATE, per: 'day', order: 'either' },
      'order is not day or month',
    ],
    [{ t: 'time', at: DATE, per: 'day', unit: 'us' }, 'unit is not s or ms'],
    [{ t: 'time', at: DATE, per: 'day' }, ONE_READING],
    [{ t: 'time', at: DATE, per: 'day', order: 'day', unit: 's' }, ONE_READING],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseOverTime(PLOT, plot)).toThrow(
      new Error(`${PLOT}: ${said}`),
    );
  });
});

const CHANNEL = { col: 2, header: 'channel' };

describe('parseStacked', () => {
  test.each<StackPlot>([
    { t: 'stack', by: REGION, split: CHANNEL },
    { t: 'stack', by: REGION, split: CHANNEL, sum: REVENUE },
    { t: 'stack', by: NO_HEADER, split: REGION, sum: REGION },
  ])('reads %j', (plot) => {
    expect(parseStacked(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'stack', by: REGION }, 'split: col is not a column number'],
    [{ t: 'stack', split: CHANNEL }, 'by: col is not a column number'],
    [
      { t: 'stack', by: REGION, split: CHANNEL, sum: { col: 4 } },
      'sum: header is not text',
    ],
    [
      { t: 'stack', by: REGION, split: { ...REGION, header: 'Region' } },
      'split names the column by names',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseStacked(PLOT, plot)).toThrow(
      new Error(`${PLOT}: ${said}`),
    );
  });

  test('a stacked plot is one parsePlot reads, and refuses a key it does not know', () => {
    const plot: StackPlot = { t: 'stack', by: REGION, split: CHANNEL };
    expect(parsePlot(PLOT, plot)).toStrictEqual(plot);
    expect(() => parsePlot(PLOT, { ...plot, per: 'day' })).toThrow(
      new Error(`${PLOT}: this build does not read "per"`),
    );
    expect(() => parsePlot(PLOT, { ...plot, split: REGION })).toThrow(
      new Error(`${PLOT}: split names the column by names`),
    );
  });
});

describe('parseChart', () => {
  test('reads a chart at its limits, and leaves out a key it does not know', () => {
    const by = { ...REGION, colour: 'teal' };
    const place = { ...PLACE, colour: 'teal' };
    const told = { ...BARS, plot: { ...BARS.plot, by }, place, colour: 'teal' };
    expect(parseChart(WHERE, told)).toStrictEqual(BARS);
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
    ['place', { ...PLACE, x: -0.5 }, 'place: x is not a fraction from 0 to 1'],
    ['place', { ...PLACE, y: 1.5 }, 'place: y is not a fraction from 0 to 1'],
    ['place', { ...PLACE, width: 0.4 }, `place: width ${NOT_SIZE}`],
    ['place', { ...PLACE, height: Infinity }, `place: height ${NOT_SIZE}`],
  ])('refuses %s %o, naming the chart and the key', (key, value, said) => {
    expect(() => parseChart(WHERE, { ...BARS, [key]: value })).toThrow(
      new Error(`${WHERE} (c1): ${said}`),
    );
  });
});
