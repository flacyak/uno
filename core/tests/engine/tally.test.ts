/**
 * @fileoverview The engine tallies a source's charts behind the index: each
 * chart hears its fold of every row as the pure fold reads it, and a partial
 * one a second while the source is still being read, and a chart reads the
 * columns its plot names, found by header where the file moved them, or
 * hears which one the file has not, or that its source could not be read.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { expect, test } from 'vite-plus/test';

import { newManifest, writeDocument } from '@document';
import type { Chart, Plot } from '@document';
import { TALLY_MS } from '@engine';
import type { Engine, SourceHandle, Tally } from '@engine';
import { Tallies } from '@engine/tally';
import type { Block } from '@engine/tally';
import { parse } from '@formula';
import { read } from '@ingest';
import type { Provider } from '@plugin';
import { Refusal } from '@said';
import type { Said } from '@said';
import { NO_ROW, Op } from '@sheet';
import type { Sheet } from '@sheet';
import { blobProvider } from '@store';
import { diskProvider } from '@store/node';
import { GroupsFold, SampleFold } from '@tally';
import {
  CHANNEL,
  COLS,
  REGION,
  REVENUE,
  ROWS,
  UNITS,
} from '@core-tests/testdata/sales-q3';
import {
  FIXTURE,
  TINY,
  bytes,
  connect,
  indexed,
  openOne,
  sales,
} from './harness.ts';

const NAME = 'sales-q3.csv';
const SOURCE = 'sales';
const FILE = { name: NAME, path: FIXTURE };
const HEADERS = sales.columns.map((c) => c.header);
/** The fixture's column `col`, as a chart names it. */
const column = (col: number) => ({ col, header: HEADERS[col]! });
/** The coverage of a tally folded from every row. */
const WHOLE = { rows: ROWS, total: ROWS, complete: true };
/** The row the edits change, inside the first block. */
const EDITED = 3;
/** A revenue above every one in the fixture, which makes its row the most. */
const ABOVE_ALL = '999999';

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

/** pure folds every row of `sheet` for `plot`, as its complete tally. */
function pure(plot: Plot, sheet: Sheet = sales): Tally {
  const cell = (row: number, at: { col: number }) => sheet.display(row, at.col);
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

/** shownRow is what each column of `sheet` shows for `row`. */
function shownRow(sheet: Sheet, row: number): string[] {
  return sheet.columns.map((_, col) => sheet.display(row, col));
}

/** blocks reads a TINY block of `sheet`, as the folds read one. */
function blocks(sheet: Sheet): (block: number) => Promise<Block> {
  const shown = (col: number) => (row: number) => sheet.display(row, col);
  return (block) => {
    const from = block * TINY.blockRows;
    const end = Math.min(from + TINY.blockRows, ROWS);
    return Promise.resolve({ from, end, shown });
  };
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

/**
 * holding returns a disk provider that counts its reads, and holds the first
 * read of a block after `arm`, which `held` reports, until `release`, or
 * refuses it with the refusal `arm` is given. A block's read is shorter than
 * an index chunk's and ends before the file does.
 */
function holding() {
  const disk = diskProvider();
  let reads = 0;
  let armed = false;
  let refusal: Refusal | undefined;
  let caught = (): void => {};
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (caught = resolve));
  const until = new Promise<void>((resolve) => (release = resolve));
  const provider: Provider = {
    ...disk,
    files: {
      ...disk.files,
      async open(ref) {
        const source = await disk.files.open(ref);
        return {
          size: source.size,
          async read(offset, length) {
            reads++;
            const block =
              length < TINY.chunkBytes && offset + length < source.size;
            if (armed && block) {
              armed = false;
              caught();
              if (refusal !== undefined) throw refusal;
              await until;
            }
            return source.read(offset, length);
          },
          close: () => source.close(),
        };
      },
    },
  };
  const arm = (refuse?: Refusal): void => {
    armed = true;
    refusal = refuse;
  };
  return { provider, arm, held, release, reads: () => reads };
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
  // A chart attached again keeps its fold while it reads the same columns.
  tallies.attach({ ...REGION_ROWS, title: 'Rows per region' }, HEADERS);
  expect(tallies.from()).toBe(ROWS);
  tallies.attach({ ...REGION_ROWS, plot: REGION_REVENUE.plot }, HEADERS);
  expect(tallies.from()).toBe(0);
});

test('charts folded a block at a time read as the pure fold of every row, and are pending until read complete', () => {
  const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
  const tallies = folded(charts);
  const read = charts.map((chart) => [chart.id, pure(chart.plot)]);
  expect(tallies.read(ROWS, true)).toStrictEqual(read);
  expect(tallies.from()).toBeUndefined();
  expect(tallies.read(ROWS, true)).toStrictEqual([]);
});

test('a chart that has folded every row of a complete index reads complete, while one still folding stays pending', () => {
  const tallies = folded([REGION_ROWS]);
  tallies.attach(REGION_REVENUE, HEADERS);
  const [whole, partial] = tallies.read(ROWS, true);
  expect(whole).toStrictEqual([REGION_ROWS.id, pure(REGION_ROWS.plot)]);
  const pending = { coverage: { rows: 0, total: ROWS, complete: false } };
  expect(partial).toMatchObject([REGION_REVENUE.id, pending]);
  expect(tallies.from()).toBe(0);
  const ids = tallies.read(ROWS, true).map(([id]) => id);
  expect(ids).toEqual([REGION_REVENUE.id]);
});

test('a chart takes the blocks the index completes ahead of the pass behind it, and joins them when the pass reaches them', () => {
  const tallies = new Tallies();
  tallies.attach(REGION_ROWS, HEADERS);
  const shown = (col: number) => (row: number) => sales.display(row, col);
  const rows = TINY.blockRows;
  const fold = (block: number) => {
    const from = block * rows;
    tallies.fold(block, from, Math.min(from + rows, ROWS), shown);
  };
  // The pass reads block 0 while the index completes blocks 3 and 4.
  for (const block of [0, 3, 4]) fold(block);
  expect(tallies.from()).toBe(rows);
  expect(tallies.wants(rows)).toBe(true);
  expect(tallies.wants(3 * rows)).toBe(false);
  const partial = [[REGION_ROWS.id, { coverage: { rows: 3 * rows } }]];
  expect(tallies.read(ROWS, false)).toMatchObject(partial);
  for (const block of [1, 2]) fold(block);
  expect(tallies.from()).toBe(5 * rows);
  for (let block = 5; block * rows < ROWS; block++) fold(block);
  const whole = [[REGION_ROWS.id, pure(REGION_ROWS.plot)]];
  expect(tallies.read(ROWS, true)).toStrictEqual(whole);
});

test('an edit moves each chart that reads its column by the one row, which is pending again, and a chart over another column is not read again', async () => {
  const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
  const tallies = folded(charts);
  tallies.read(ROWS, true);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, REVENUE, '1');
  const block = Math.floor(EDITED / TINY.blockRows);
  const after = shownRow(sheet, EDITED);
  const moved = tallies.cell(block, EDITED, before, after);
  await tallies.mend(moved, blocks(sheet));
  const over = [REGION_REVENUE, UNITS_REVENUE];
  const again = over.map((chart) => [chart.id, pure(chart.plot, sheet)]);
  expect(tallies.read(ROWS, true)).toStrictEqual(again);
});

test('a scatter whose edit took back its most folds that block again, so its extent is exact', async () => {
  const tallies = folded([UNITS_REVENUE]);
  tallies.read(ROWS, true);
  const sheet = read(NAME, bytes);
  const block = Math.floor(EDITED / TINY.blockRows);
  for (const revenue of [ABOVE_ALL, '1']) {
    const before = shownRow(sheet, EDITED);
    sheet.set(EDITED, REVENUE, revenue);
    const after = shownRow(sheet, EDITED);
    const moved = tallies.cell(block, EDITED, before, after);
    await tallies.mend(moved, blocks(sheet));
    const again = [[UNITS_REVENUE.id, pure(UNITS_REVENUE.plot, sheet)]];
    expect(tallies.read(ROWS, true)).toStrictEqual(again);
  }
});

test('a scatter whose block cannot be read again is the one told its source could not be read, and a chart still folding goes on', async () => {
  const tallies = folded([UNITS_REVENUE]);
  tallies.read(ROWS, true);
  tallies.attach(REGION_ROWS, HEADERS);
  const sheet = read(NAME, bytes);
  const block = Math.floor(EDITED / TINY.blockRows);
  const was = shownRow(sheet, EDITED);
  sheet.set(EDITED, REVENUE, ABOVE_ALL);
  const most = shownRow(sheet, EDITED);
  await tallies.mend(tallies.cell(block, EDITED, was, most), blocks(sheet));
  sheet.set(EDITED, REVENUE, '1');
  const moved = tallies.cell(block, EDITED, most, shownRow(sheet, EDITED));
  const unreadable = () => Promise.reject(new Error('unreadable'));
  await expect(tallies.mend(moved, unreadable)).rejects.toThrow('unreadable');
  const said: Said = { t: 'changed-on-disk', name: NAME };
  const unread = [[UNITS_REVENUE.id, { t: 'unread', said }]];
  expect(tallies.unread(said, moved)).toStrictEqual(unread);
  const pending = tallies.read(ROWS, true).map(([id]) => id);
  expect(pending).toEqual([REGION_ROWS.id]);
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

test('a chart hears a partial tally after TALLY_MS while its source is still being read, then the complete one', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider, blobProvider()]);
  try {
    const heard = new Heard(await opened(engine, [REGION_ROWS]));
    const last = heard.of(REGION_ROWS.id);
    hold.arm();
    await hold.held;
    await sleep(TALLY_MS);
    hold.release();
    expect(await last).toStrictEqual(pure(REGION_ROWS.plot));

    const [, partial] = heard.all[0]!;
    if (partial.t === 'unread') throw new Error('the first tally is unread');
    expect(partial.coverage.complete).toBe(false);
    expect(partial.coverage.rows).toBeGreaterThan(0);
    expect(partial.coverage.rows).toBeLessThan(ROWS);
  } finally {
    done();
  }
});

test("a chart's column is found by its header where the file moved it, and each chart over a column the file has not hears which", async () => {
  const { engine, done } = connect(TINY);
  try {
    const region = { col: REVENUE, header: 'region' };
    const moved: Chart = { ...REGION_ROWS, plot: { t: 'bars', by: region } };
    const margin = { col: REGION, header: 'margin' };
    const gone: Chart = { ...moved, id: 'c2', plot: { t: 'pie', by: margin } };
    const cost = { col: UNITS, header: 'cost' };
    const x = column(UNITS);
    const also: Chart = {
      ...moved,
      id: 'c3',
      plot: { t: 'scatter', x, y: cost },
    };
    const charts = [moved, gone, also];
    const heard = new Heard(await opened(engine, charts));
    const [one, two, three] = charts.map((chart) => heard.of(chart.id));
    expect(await one).toStrictEqual(pure(REGION_ROWS.plot));
    const unread = (header: string) => ({
      t: 'unread',
      said: { t: 'chart-column-gone', header, name: NAME },
    });
    expect(await two).toStrictEqual(unread('margin'));
    expect(await three).toStrictEqual(unread('cost'));
  } finally {
    done();
  }
});

test('a chart whose source cannot be read hears why, once, and one added afterwards is tallied', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider, blobProvider()]);
  try {
    const charts = [REGION_ROWS, REGION_REVENUE];
    const src = await opened(engine, charts);
    const heard = new Heard(src);
    const lasts = charts.map((chart) => heard.of(chart.id));
    const said: Said = { t: 'changed-on-disk', name: NAME };
    hold.arm(new Refusal(said));
    for (const last of lasts) {
      expect(await last).toStrictEqual({ t: 'unread', said });
    }
    // A round trip, after which anything posted before it has landed.
    await src.rows(0, 1);
    const unread = charts.map((chart) => [chart.id, { t: 'unread', said }]);
    expect(heard.all).toStrictEqual(unread);

    const last = heard.of(UNITS_REVENUE.id);
    await engine.chart(UNITS_REVENUE);
    expect(await last).toStrictEqual(pure(UNITS_REVENUE.plot));
  } finally {
    done();
  }
});

test('a chart over a bound column tallies what the column computes', async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, FILE);
    engine.mode(true);
    const formula = 'revenue / 1000';
    await src.edit({ op: Op.Bind, row: NO_ROW, col: CHANNEL, now: formula });
    const last = new Heard(src).of(REGION_ROWS.id);
    const plot: Plot = { t: 'bars', by: column(REGION), sum: column(CHANNEL) };
    await engine.chart({ ...REGION_ROWS, source: src.id, plot });

    const sheet = read(NAME, bytes);
    sheet.bind(CHANNEL, parse(formula));
    expect(await last).toStrictEqual(pure(plot, sheet));
  } finally {
    done();
  }
});

test('a chart added once the source is read hears its tally, and one replaced hears it again, from the fold it kept while it reads the same columns', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider]);
  try {
    const src = await openOne(engine, FILE);
    await indexed(src);
    const heard = new Heard(src);
    const chart = { ...REGION_ROWS, source: src.id };
    let last = heard.of(chart.id);
    await engine.chart(chart);
    expect(await last).toStrictEqual(pure(chart.plot));

    const reads = hold.reads();
    last = heard.of(chart.id);
    await engine.chart({ ...chart, title: 'Rows per region' });
    expect(await last).toStrictEqual(pure(chart.plot));
    expect(hold.reads()).toBe(reads);

    const plot: Plot = { t: 'bars', by: column(CHANNEL) };
    last = heard.of(chart.id);
    await engine.chart({ ...chart, plot });
    expect(await last).toStrictEqual(pure(plot));
    expect(hold.reads()).toBeGreaterThan(reads);
  } finally {
    done();
  }
});

test('a chart added while another is being folded joins the pass, and neither counts a row twice', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider, blobProvider()]);
  try {
    const heard = new Heard(await opened(engine, [REGION_ROWS]));
    const one = heard.of(REGION_ROWS.id);
    const two = heard.of(REGION_REVENUE.id);
    hold.arm();
    await hold.held;
    await engine.chart(REGION_REVENUE);
    hold.release();
    expect(await one).toStrictEqual(pure(REGION_ROWS.plot));
    expect(await two).toStrictEqual(pure(REGION_REVENUE.plot));
  } finally {
    done();
  }
});

test('an uncharted chart is not heard from again, while another over the source still is', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider, blobProvider()]);
  try {
    const src = await opened(engine, [REGION_ROWS, REGION_REVENUE]);
    const heard = new Heard(src);
    const last = heard.of(REGION_REVENUE.id);
    hold.arm();
    await hold.held;
    await engine.unchart(REGION_ROWS.id);
    hold.release();
    expect(await last).toStrictEqual(pure(REGION_REVENUE.plot));
    // A round trip, after which anything posted before it has landed.
    await src.rows(0, 1);
    const charts = new Set(heard.all.map(([chart]) => chart));
    expect([...charts]).toEqual([REGION_REVENUE.id]);
  } finally {
    done();
  }
});

test('a source pointed at a file again hears tallies of its new view alone, and none from the one it replaced', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider, blobProvider()]);
  try {
    const was = await opened(engine, [REGION_ROWS]);
    hold.arm();
    await hold.held;
    const src = await engine.relink(was, FILE);
    const heard = new Heard(src);
    const last = heard.of(REGION_ROWS.id);
    hold.release();
    expect(await last).toStrictEqual(pure(REGION_ROWS.plot));
    await src.rows(0, 1);
    expect(heard.all).toStrictEqual([[REGION_ROWS.id, pure(REGION_ROWS.plot)]]);
  } finally {
    done();
  }
});
