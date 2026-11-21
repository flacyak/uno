/**
 * @fileoverview A chart's record: what the codec reads of one, and how it
 * names a field it refuses.
 */

import { describe, expect, test } from 'vite-plus/test';

import { REFRESH_MINUTES_AT_MOST, TITLE_AT_MOST, parseChart } from '@document';
import type {
  Chart,
  ChordPlot,
  Plot,
  HeatPlot,
  SlopePlot,
  StackPlot,
  ParallelPlot,
  MapPlot,
  PlacesPlot,
  SwarmPlot,
  TimePlot,
  WeekPlot,
} from '@document';
import {
  parseChord,
  parseOverTime,
  parsePlot,
  parseSlope,
  parseHeat,
  parseStacked,
  parseParallel,
  parseMap,
  parsePlaces,
  parseSwarm,
  parseWeek,
} from '@document/codec';
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
    { t: 'box', of: REVENUE, span: 'most' },
    { t: 'box', of: REVENUE, by: REGION, span: 'all' },
    { t: 'dots', by: REGION },
    { t: 'dots', by: REGION, of: REVENUE, measure: 'mean' },
    { t: 'dots', by: REGION, of: UNITS, measure: 'sum', order: ['East'] },
    { t: 'week', at: DATE, sum: REVENUE, unit: 'ms' },
    { t: 'heat', by: REGION, at: DATE, per: 'day', order: 'month' },
    { t: 'horizon', at: DATE, per: 'week', order: 'day' },
    { t: 'swarm', of: REVENUE, by: REGION },
    { t: 'parallel', axes: [REVENUE, REGION, DATE] },
    { t: 'chord', from: REGION, to: DATE, sum: REVENUE },
    { t: 'map', lat: UNITS, lon: REVENUE, projection: 'world' },
    {
      t: 'horizon',
      at: DATE,
      by: REGION,
      sum: REVENUE,
      per: 'auto',
      unit: 's',
    },
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
      { t: 'week', at: DATE, per: 'day', order: 'day' },
      'this build does not read "per"',
    ],
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
    [{ t: 'dots', by: REGION, of: REVENUE }, 'measure is not sum or mean'],
    [
      { t: 'dots', by: REGION, measure: 'mean' },
      'measure names no column of numbers',
    ],
    [
      { t: 'dots', by: REGION, of: REVENUE, measure: 'median' },
      'measure is not sum or mean',
    ],
    [
      { t: 'dots', by: REGION, of: REGION, measure: 'sum' },
      'of and by name one column',
    ],
    [
      { t: 'box', of: REVENUE, by: REVENUE, span: 'most' },
      'by names the column of names',
    ],
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

describe('parseParallel', () => {
  const UNITS = { col: 3, header: 'units' };
  test.each<ParallelPlot>([
    { t: 'parallel', axes: [REVENUE, REGION, UNITS] },
    {
      t: 'parallel',
      axes: Array.from({ length: 8 }, (_, col) => ({ col, header: `c${col}` })),
    },
  ])('reads %j', (plot) => {
    expect(parseParallel(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'parallel' }, 'axes is not a list'],
    [{ t: 'parallel', axes: [REVENUE, UNITS] }, 'axes are 3 to 8 columns'],
    [
      { t: 'parallel', axes: Array(9).fill(REVENUE) },
      'axes are 3 to 8 columns',
    ],
    [
      { t: 'parallel', axes: [REVENUE, UNITS, REVENUE] },
      'axes name a column twice',
    ],
    [
      { t: 'parallel', axes: [REVENUE, UNITS, 1] },
      'axes: 2: col is not a column number',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseParallel(PLOT, plot)).toThrow(
      new Error(`${PLOT}: ${said}`),
    );
  });
});

const LAT = { col: 2, header: 'lat' };
const LON = { col: 3, header: 'lon' };

describe('parseMap', () => {
  test.each<MapPlot>([
    { t: 'map', lat: LAT, lon: LON },
    { t: 'map', lat: LAT, lon: LON, sum: REVENUE, projection: 'world' },
    {
      t: 'map',
      lat: LAT,
      lon: LON,
      projection: 'us',
      box: { south: 40.5, west: -74.25, north: 41, east: -73.75 },
    },
  ])('reads %j', (plot) => {
    expect(parseMap(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'map', lat: LAT }, 'lon: col is not a column number'],
    [{ t: 'map', lat: LAT, lon: LAT }, 'lat and lon name one column'],
    [
      { t: 'map', lat: LAT, lon: LON, sum: LON },
      'sum names a coordinate column',
    ],
    [
      { t: 'map', lat: LAT, lon: LON, projection: 'mercator' },
      'projection is not us or world',
    ],
    [
      {
        t: 'map',
        lat: LAT,
        lon: LON,
        box: { south: 41, west: -74, north: 40, east: -73 },
      },
      'box is not south, west, north and east in degrees, south below north and west of east',
    ],
    [
      {
        t: 'map',
        lat: LAT,
        lon: LON,
        box: { south: 0, west: 0, north: 91, east: 1 },
      },
      'box is not south, west, north and east in degrees, south below north and west of east',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseMap(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});

describe('parsePlaces', () => {
  test.each<PlacesPlot>([
    { t: 'places', by: REGION, reads: { level: 'country' } },
    {
      t: 'places',
      by: REGION,
      reads: { level: 'region', country: 'US' },
      sum: REVENUE,
    },
  ])('reads %j', (plot) => {
    expect(parsePlaces(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [
      { t: 'places', by: REGION },
      "reads is not a reading of countries or of a region country's regions",
    ],
    [
      { t: 'places', by: REGION, reads: { level: 'region', country: 'JP' } },
      "reads is not a reading of countries or of a region country's regions",
    ],
    [
      { t: 'places', by: REGION, reads: { level: 'country' }, sum: REGION },
      'by and sum name one column',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parsePlaces(PLOT, plot)).toThrow(
      new Error(`${PLOT}: ${said}`),
    );
  });
});

describe('parseChord', () => {
  const DEST = { col: 2, header: 'dest' };
  test.each<ChordPlot>([
    { t: 'chord', from: REGION, to: DEST },
    { t: 'chord', from: REGION, to: DEST, sum: REVENUE },
  ])('reads %j', (plot) => {
    expect(parseChord(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'chord', to: DEST }, 'from: col is not a column number'],
    [{ t: 'chord', from: REGION, to: REGION }, 'from and to name one column'],
    [
      { t: 'chord', from: REGION, to: DEST, sum: DEST },
      'sum and to name one column',
    ],
    [
      { t: 'chord', from: REGION, to: DEST, sum: 1 },
      'sum: col is not a column number',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseChord(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});

describe('parseSwarm', () => {
  test.each<SwarmPlot>([
    { t: 'swarm', of: REVENUE },
    { t: 'swarm', of: REVENUE, by: REGION },
  ])('reads %j', (plot) => {
    expect(parseSwarm(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'swarm', by: REGION }, 'of: col is not a column number'],
    [{ t: 'swarm', of: REVENUE, by: REVENUE }, 'by and of name one column'],
    [{ t: 'swarm', of: REVENUE, by: 1 }, 'by: col is not a column number'],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseSwarm(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});

describe('parseHeat', () => {
  test.each<HeatPlot>([
    { t: 'heat', by: REGION, at: DATE, per: 'month', order: 'day' },
    { t: 'heat', by: REGION, at: DATE, sum: REVENUE, per: 'auto', unit: 'ms' },
  ])('reads %j', (plot) => {
    expect(parseHeat(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [
      { t: 'heat', at: DATE, per: 'day', order: 'day' },
      'by: col is not a column number',
    ],
    [
      { t: 'heat', by: REGION, at: REGION, per: 'day', order: 'day' },
      'by and at name one column',
    ],
    [
      { t: 'heat', by: REGION, at: DATE, order: 'day' },
      `per is not one of ${PERS}`,
    ],
    [{ t: 'heat', by: REGION, at: DATE, per: 'day' }, ONE_READING],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseHeat(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });
});

describe('parseWeek', () => {
  test.each<WeekPlot>([
    { t: 'week', at: DATE, order: 'month' },
    { t: 'week', at: DATE, sum: REVENUE, order: 'day' },
    { t: 'week', at: DATE, unit: 's' },
  ])('reads %j', (plot) => {
    expect(parseWeek(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[unknown, string]>([
    [{ t: 'week', order: 'day' }, 'at: col is not a column number'],
    [
      { t: 'week', at: DATE, sum: 4, order: 'day' },
      'sum: col is not a column number',
    ],
    [{ t: 'week', at: DATE, order: 'either' }, 'order is not day or month'],
    [{ t: 'week', at: DATE }, ONE_READING],
    [{ t: 'week', at: DATE, order: 'day', unit: 'ms' }, ONE_READING],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseWeek(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
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

describe('parseSlope', () => {
  const YEAR = { col: 0, header: 'year' };
  test.each<SlopePlot>([
    { t: 'slope', by: REGION, between: YEAR, from: '2024', to: '' },
    {
      t: 'slope',
      by: REGION,
      between: YEAR,
      from: '2024',
      to: '2025',
      of: REVENUE,
      measure: 'mean',
    },
  ])('reads %j', (plot) => {
    expect(parseSlope(PLOT, plot)).toStrictEqual(plot);
  });

  test.each<[Record<string, unknown>, string]>([
    [
      { t: 'slope', by: REGION, between: YEAR, from: '2024', to: '2024' },
      'from and to name one value',
    ],
    [
      { t: 'slope', by: REGION, between: REGION, from: 'a', to: 'b' },
      'between and by name one column',
    ],
    [
      { t: 'slope', by: REGION, between: YEAR, from: 1, to: 'b' },
      'from is not text',
    ],
    [
      {
        t: 'slope',
        by: REGION,
        between: YEAR,
        from: 'a',
        to: 'b',
        of: YEAR,
        measure: 'sum',
      },
      'of and between name one column',
    ],
    [
      {
        t: 'slope',
        by: REGION,
        between: YEAR,
        from: 'a',
        to: 'b',
        of: REVENUE,
      },
      'measure is not sum or mean',
    ],
  ])('refuses %j, naming the key', (plot, said) => {
    expect(() => parseSlope(PLOT, plot)).toThrow(new Error(`${PLOT}: ${said}`));
  });

  test('a slope is one parsePlot reads, and refuses a key it does not know', () => {
    const plot: SlopePlot = {
      t: 'slope',
      by: REGION,
      between: YEAR,
      from: 'a',
      to: 'b',
    };
    expect(parsePlot(PLOT, plot)).toStrictEqual(plot);
    expect(() => parsePlot(PLOT, { ...plot, order: [] })).toThrow(
      new Error(`${PLOT}: this build does not read "order"`),
    );
  });
});
