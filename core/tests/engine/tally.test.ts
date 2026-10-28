/**
 * @fileoverview The engine tallies a source's charts behind the index: each
 * chart hears its fold of every row as the pure fold reads it, and a chart
 * reads the columns its plot names, found by header where the file moved
 * them.
 */

import { expect, test } from 'vite-plus/test';

import { newManifest, writeDocument } from '@document';
import type { Chart, Plot } from '@document';
import type { Engine, SourceHandle, Tally } from '@engine';
import { Tallies } from '@engine/tally';
import { GroupsFold, SampleFold } from '@tally';
import {
  COLS,
  REGION,
  REVENUE,
  ROWS,
  UNITS,
} from '@core-tests/testdata/sales-q3';
import { FIXTURE, TINY, connect, openOne, sales } from './harness.ts';

const NAME = 'sales-q3.csv';
const SOURCE = 'sales';
const FILE = { name: NAME, path: FIXTURE };
const HEADERS = sales.columns.map((c) => c.header);
/** The fixture's column `col`, as a chart names it. */
const column = (col: number) => ({ col, header: HEADERS[col]! });
/** The coverage of a tally folded from every row. */
const WHOLE = { rows: ROWS, total: ROWS, complete: true };

/** Rows per region, placed as a save writes a new chart. */
const REGION_ROWS: Chart = {
  id: 'c1',
  source: SOURCE,
  plot: { t: 'bars', by: column(REGION) },
  title: '',
  place: { x: 1, y: 0, width: 420, height: 260 },
  refresh: 0,
};
/** Each region's share of the revenue. */
const REGION_REVENUE: Chart = {
  ...REGION_ROWS,
  id: 'c2',
  plot: { t: 'pie', by: column(REGION), sum: column(REVENUE) },
};
/** Revenue against units. */
const UNITS_REVENUE: Chart = {
  ...REGION_ROWS,
  id: 'c3',
  plot: { t: 'scatter', x: column(UNITS), y: column(REVENUE) },
};

/** pure folds every row of the sheet for `plot`, as its complete tally. */
function pure(plot: Plot): Tally {
  const cell = (row: number, at: { col: number }) => sales.display(row, at.col);
  if (plot.t === 'scatter') {
    const fold = new SampleFold();
    for (let r = 0; r < ROWS; r++)
      fold.add(0, r, cell(r, plot.x), cell(r, plot.y));
    return { t: 'sample', coverage: WHOLE, ...fold.snapshot() };
  }
  const { by, sum } = plot;
  const fold = new GroupsFold(sum === undefined ? 'rows' : 'sum');
  for (let r = 0; r < ROWS; r++) {
    fold.add(cell(r, by), sum === undefined ? '' : cell(r, sum));
  }
  return { t: 'groups', coverage: WHOLE, ...fold.snapshot() };
}

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

/** Heard collects the tallies a handle hears, and waits for a chart's last. */
class Heard {
  readonly all: Array<[string, Tally]> = [];
  private readonly waiting = new Map<string, (tally: Tally) => void>();

  constructor(handle: SourceHandle) {
    handle.onTally = (chart, tally) => {
      this.all.push([chart, tally]);
      if (tally.t === 'unread' || tally.coverage.complete) {
        this.waiting.get(chart)?.(tally);
      }
    };
  }

  /** of resolves with the next complete tally of `chart`, or why it has none. */
  of(chart: string): Promise<Tally> {
    return new Promise((resolve) => this.waiting.set(chart, resolve));
  }
}

/** opened opens a .uno of the fixture as SOURCE, holding `charts`. */
function opened(engine: Engine, charts: Chart[]): Promise<SourceHandle> {
  const state = { active: { row: 0, col: 0 } };
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [{ id: SOURCE, ...FILE, rows: ROWS, cols: COLS, state }],
    active: SOURCE,
    log: [],
    charts,
    carriedCharts: [],
    extra: new Map(),
    at: '',
  });
  const blob = new Blob([new Uint8Array(uno)]);
  return openOne(engine, { name: 'q3.uno', blob });
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

test('charts folded a block at a time read as the pure fold of every row, and are pending until read complete', () => {
  const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
  const tallies = folded(charts);
  const read = charts.map((chart) => [chart.id, pure(chart.plot)]);
  expect(tallies.read(ROWS, true)).toStrictEqual(read);
  expect(tallies.from()).toBeUndefined();
  expect(tallies.read(ROWS, true)).toStrictEqual([]);
});

test('each chart of a .uno hears its fold of every row, as the pure fold reads it', async () => {
  const { engine, done } = connect(TINY);
  try {
    const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
    const heard = new Heard(await opened(engine, charts));
    const lasts = charts.map((chart) => heard.of(chart.id));
    for (const [i, chart] of charts.entries()) {
      expect(await lasts[i]).toStrictEqual(pure(chart.plot));
    }
  } finally {
    done();
  }
});
