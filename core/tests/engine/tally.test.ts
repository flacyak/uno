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
import type { Chart, Plot, SlopePlot } from '@document';
import { TALLY_MS } from '@engine';
import type {
  Coverage,
  EditRequest,
  Engine,
  SourceHandle,
  SourceRef,
  Tally,
} from '@engine';
import { counted } from '@engine/fold/counted';
import { groupsFolder } from '@engine/fold/groups';
import { FOLDERS } from '@engine/fold/index';
import type { Folder, Folders, MakeFolder } from '@engine/fold/index';
import { sampleFolder } from '@engine/fold/sample';
import { splitFolder } from '@engine/fold/split';
import { Tallies } from '@engine/tally';
import type { Block } from '@engine/tally';
import { parse } from '@formula';
import { read } from '@ingest';
import type { Provider } from '@plugin';
import { Refusal } from '@said';
import type { Said } from '@said';
import { NO_ROW, Op } from '@sheet';
import type { Edit, Sheet } from '@sheet';
import { blobProvider, multiProvider } from '@store';
import { diskProvider } from '@store/node';
import {
  GroupsFold,
  LEVEL_BATCH,
  SampleFold,
  SplitFold,
  SpreadFold,
  SpreadsFold,
  TimeFold,
} from '@tally';
import {
  CHANNEL,
  COLS,
  LAST_ROW,
  REGION,
  REVENUE,
  ROWS,
  UNITS,
} from '@core-tests/testdata/sales-q3';
import {
  PARTS,
  PART_FIXTURES,
  PART_NAMES,
  PART_ROWS,
} from '@core-tests/testdata/sales-q3-parts';
import {
  FIXTURE,
  TINY,
  bytes,
  connect,
  indexed,
  multiProviders,
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
/** The byte that ends each line of the fixture. */
const NEWLINE = '\n'.charCodeAt(0);
/** How many parts of the fixture a source is opened with, before the last is appended. */
const OPENED = PARTS - 1;
/** How many rows the source has before the append. */
const ROWS_BEFORE = PART_ROWS * OPENED;
/** Part `i` of the fixture as a ref to its file on disk. */
const part = (i: number) => ({ name: PART_NAMES[i]!, path: PART_FIXTURES[i]! });
/** The parts the source is opened with, as one ref. */
const FIRST_TWO: SourceRef = {
  name: 'sales-q3',
  parts: Array.from({ length: OPENED }, (_, i) => ({ ref: part(i) })),
  header: 'first',
};
/** The part that is appended. */
const THIRD = part(OPENED);

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

/** The fixture's dates: rows per month, and revenue per week, read day first. */
const DATES = 0;
const PER_MONTH: Chart = {
  ...REGION_ROWS,
  id: 'c4',
  plot: { t: 'time', at: column(DATES), per: 'month', order: 'day' },
};
const REVENUE_WEEKLY: Chart = {
  ...REGION_ROWS,
  id: 'c5',
  plot: {
    t: 'time',
    at: column(DATES),
    sum: column(REVENUE),
    per: 'week',
    order: 'day',
  },
};
/** The fixture's rows per region by channel, and its revenue the same way. */
const STACKED: Chart = {
  ...REGION_ROWS,
  id: 'c6',
  plot: { t: 'stack', by: column(REGION), split: column(CHANNEL) },
};
const REVENUE_STACKED: Chart = {
  ...REGION_ROWS,
  id: 'c7',
  plot: {
    t: 'stack',
    by: column(REGION),
    split: column(CHANNEL),
    sum: column(REVENUE),
  },
};

/** The fixture's units over their 1st to 99th percentile, and its revenue over every number. */
const UNITS_SPREAD: Chart = {
  ...REGION_ROWS,
  id: 'c8',
  plot: { t: 'histogram', of: column(UNITS), span: 'most' },
};
const REVENUE_SPREAD: Chart = {
  ...REGION_ROWS,
  id: 'c9',
  plot: { t: 'histogram', of: column(REVENUE), span: 'all' },
};

/** The fixture's units as one box, and its revenue as a box per region. */
const UNITS_BOX: Chart = {
  ...REGION_ROWS,
  id: 'c10',
  plot: { t: 'box', of: column(UNITS), span: 'most' },
};
const REVENUE_BOXES: Chart = {
  ...REGION_ROWS,
  id: 'c11',
  plot: { t: 'box', of: column(REVENUE), by: column(REGION), span: 'most' },
};

/** The fixture's mean units per channel, as dots. */
const CHANNEL_MEANS: Chart = {
  ...REGION_ROWS,
  id: 'c11',
  plot: { t: 'dots', by: column(CHANNEL), of: column(UNITS), measure: 'mean' },
};

/** The fixture's revenue per region, from the web channel to the direct one. */
const WEB_TO_DIRECT: SlopePlot = {
  t: 'slope',
  by: column(REGION),
  between: column(CHANNEL),
  from: 'web',
  to: 'direct',
  of: column(REVENUE),
  measure: 'sum',
};
const CHANNEL_SLOPE: Chart = { ...REGION_ROWS, id: 'c12', plot: WEB_TO_DIRECT };

/** A date in the fixture's span that no row of it holds. */
const LATER = '2026-12-25';

/** pure folds the first `rows` of `sheet` for `plot`, as its complete tally. */
function pure(plot: Plot, sheet: Sheet = sales, rows = ROWS): Tally {
  const cell = (row: number, at: { col: number }) => sheet.display(row, at.col);
  const coverage =
    rows === ROWS ? WHOLE : { rows, total: rows, complete: true };
  if (plot.t === 'scatter') {
    const fold = new SampleFold({ x: 'point', y: 'point' });
    for (let r = 0; r < rows; r++)
      fold.add(0, r, cell(r, plot.x), cell(r, plot.y));
    return { t: 'sample', plot, coverage, ...fold.snapshot() };
  }
  if (plot.t === 'stack') {
    const { by, split, sum } = plot;
    const fold = new SplitFold(sum === undefined ? undefined : 'point');
    for (let r = 0; r < rows; r++) {
      const cells = sum === undefined ? '' : cell(r, sum);
      fold.add(cell(r, by), cell(r, split), cells);
    }
    return { t: 'stack', plot, coverage, ...fold.snapshot(plot.order) };
  }
  if (plot.t === 'box' && plot.by !== undefined) {
    const fold = new SpreadsFold('point');
    for (let r = 0; r < rows; r++) fold.add(cell(r, plot.by), cell(r, plot.of));
    return {
      t: 'box',
      plot,
      coverage,
      ...fold.snapshot(),
      skipped: fold.skipped(),
    };
  }
  if (plot.t === 'box') {
    const fold = new SpreadFold('point');
    for (let r = 0; r < rows; r++) fold.add(cell(r, plot.of));
    const rest = fold.boxed();
    return {
      t: 'box',
      plot,
      coverage,
      values: [],
      rest,
      skipped: rest.skipped,
    };
  }
  if (plot.t === 'histogram') {
    const fold = new SpreadFold('point');
    for (let r = 0; r < rows; r++) fold.add(cell(r, plot.of));
    return { t: 'spread', plot, coverage, ...fold.snapshot(plot.span) };
  }
  if (plot.t === 'time') {
    const reading = 'order' in plot ? plot.order : plot.unit;
    const { at, sum } = plot;
    const fold = new TimeFold(reading, sum === undefined ? undefined : 'point');
    for (let r = 0; r < rows; r++) {
      fold.add(cell(r, at), sum === undefined ? '' : cell(r, sum));
    }
    return { t: 'time', plot, coverage, ...fold.snapshot(plot.per) };
  }
  if (plot.t === 'slope') {
    const fold = new SplitFold(plot.of === undefined ? undefined : 'point');
    for (let r = 0; r < rows; r++) {
      const sum = plot.of === undefined ? '' : cell(r, plot.of);
      fold.add(cell(r, plot.by), cell(r, plot.between), sum);
    }
    const ends = [plot.from, plot.to] as const;
    return {
      t: 'slope',
      plot,
      coverage,
      ...fold.slope(ends, plot.measure === 'mean'),
    };
  }
  if (plot.t === 'dots' && plot.measure === 'mean') {
    const fold = new GroupsFold('mean', 'point');
    for (let r = 0; r < rows; r++) fold.add(cell(r, plot.by), cell(r, plot.of));
    return { t: 'mean', plot, coverage, ...fold.means(plot.order) };
  }
  const by = plot.by;
  const sum = plot.t === 'dots' ? plot.of : plot.sum;
  const fold =
    sum === undefined ? new GroupsFold() : new GroupsFold('sum', 'point');
  for (let r = 0; r < rows; r++) {
    fold.add(cell(r, by), sum === undefined ? '' : cell(r, sum));
  }
  const moved = plot.t === 'pie' ? [] : plot.order;
  return { t: 'groups', plot, coverage, ...fold.snapshot(moved) };
}

/** folded attaches `charts` and folds the first `rows` of the sheet, a TINY block at a time, through `folders`. */
function folded(charts: Chart[], rows = ROWS, folders = FOLDERS): Tallies {
  const tallies = new Tallies(folders);
  for (const chart of charts) tallies.attach(chart, HEADERS);
  const shown = (col: number) => (row: number) => sales.display(row, col);
  for (let from = 0; from < rows; from += TINY.blockRows) {
    const end = Math.min(from + TINY.blockRows, rows);
    tallies.fold(from / TINY.blockRows, from, end, shown);
  }
  return tallies;
}

/**
 * LengthsFolder counts rows by how long the cell of one column is, a fold no
 * chart kind makes, so a test can tell that the tallies fold through the
 * folder their table names and know nothing of its kind.
 */
class LengthsFolder implements Folder {
  readonly key: string;
  readonly cols: readonly number[];
  readonly lengths: GroupsFold;

  constructor(col: number, lengths = new GroupsFold()) {
    this.cols = [col];
    this.key = `lengths ${col}`;
    this.lengths = lengths;
  }

  fold(_block: number, { from, end, shown }: Block): void {
    const cell = shown(this.cols[0]!);
    for (let row = from; row < end; row++)
      this.lengths.add(`${cell(row).length}`);
  }

  unfold(_block: number, { from, end, shown }: Block): void {
    const cell = shown(this.cols[0]!);
    for (let row = from; row < end; row++)
      this.lengths.remove(`${cell(row).length}`);
  }

  move(
    _block: number,
    _row: number,
    before: readonly string[],
    after: readonly string[],
  ): void {
    const col = this.cols[0]!;
    this.lengths.remove(`${before[col]!.length}`);
    this.lengths.add(`${after[col]!.length}`);
  }

  readsWith(): boolean {
    return true;
  }

  again(): Folder {
    return new LengthsFolder(this.cols[0]!);
  }

  restored(saved: unknown): Folder | undefined {
    const back = GroupsFold.restored(saved);
    return back && new LengthsFolder(this.cols[0]!, back);
  }

  saved(): object {
    return this.lengths.saved();
  }

  tally(plot: Plot, coverage: Coverage): Tally {
    return { t: 'groups', plot, coverage, ...this.lengths.snapshot() };
  }

  mend(): Promise<void> {
    return Promise.resolve();
  }
}

/** A table whose bars count rows by the length of their By cell. */
const lengthsBars: MakeFolder<Extract<Plot, { t: 'bars' }>> = ({ by }) =>
  new LengthsFolder(by.col);
const LENGTHS: Folders = { ...FOLDERS, bars: lengthsBars };

/** lengthsOf is the lengths of `col`'s cells in the first `rows` of `sheet`, as a complete tally of `plot`. */
function lengthsOf(
  plot: Plot,
  col: number,
  sheet: Sheet = sales,
  rows = ROWS,
): Tally {
  const lengths = new GroupsFold();
  for (let r = 0; r < rows; r++) lengths.add(`${sheet.display(r, col).length}`);
  return { t: 'groups', plot, coverage: WHOLE, ...lengths.snapshot() };
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

/** rowAt is the fixture row that starts at byte `offset`, under the header. */
function rowAt(offset: number): number {
  const lines = bytes.subarray(0, offset).filter((byte) => byte === NEWLINE);
  return lines.length - 1;
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
 * read after `arm` of a block, or of a block or a whole chunk of the file at
 * `path` where one is named, which `held` reports with its offset, until
 * `release`, or refuses it with the refusal `arm` is given. A block's read is
 * shorter than an index chunk's and ends before the file does.
 */
function holding(path?: string) {
  const disk = diskProvider();
  let reads = 0;
  let armed = false;
  let refusal: Refusal | undefined;
  let caught: (offset: number) => void = () => {};
  let release = (): void => {};
  const held = new Promise<number>((resolve) => (caught = resolve));
  const until = new Promise<void>((resolve) => (release = resolve));
  const provider: Provider = {
    ...disk,
    files: {
      ...disk.files,
      async open(ref) {
        const source = await disk.files.open(ref);
        const named = 'path' in ref && ref.path === path;
        return {
          size: source.size,
          async read(offset, length) {
            reads++;
            const block =
              length < TINY.chunkBytes && offset + length < source.size;
            const chunk = length === TINY.chunkBytes;
            const wanted =
              path === undefined ? block : named && (block || chunk);
            if (armed && wanted) {
              armed = false;
              caught(offset);
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

test('a kind folds through the folder its table names, and moves by an edit and saves through it, with nothing of its kind in the tallies', async () => {
  const tallies = folded([REGION_ROWS], ROWS, LENGTHS);
  const plot = REGION_ROWS.plot;
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [REGION_ROWS.id, lengthsOf(plot, REGION)],
  ]);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, REGION, 'Antarctica and beyond');
  const block = Math.floor(EDITED / TINY.blockRows);
  const ids = tallies.cell(block, EDITED, before, shownRow(sheet, EDITED));
  await tallies.mend(ids, blocks(sheet));
  const moved = lengthsOf(plot, REGION, sheet);
  expect(tallies.read(ROWS, true)).toStrictEqual([[REGION_ROWS.id, moved]]);
  const saved = tallies.saved();
  expect(saved[REGION_ROWS.id]?.key).toBe(`lengths ${REGION}`);
  const reopened = new Tallies(LENGTHS);
  reopened.restore(JSON.parse(JSON.stringify(saved)), ROWS);
  reopened.attach(REGION_ROWS, HEADERS);
  expect(reopened.from()).toBe(ROWS);
  expect(reopened.read(ROWS, true)).toStrictEqual([[REGION_ROWS.id, moved]]);
});

test('a counted folder counts each row by its cell, sums the column it names with its mark, and moves an edited row', () => {
  const fold = new GroupsFold('sum', 'comma');
  const unread = () => undefined;
  const folder = counted(REGION, REVENUE, fold, {
    key: 'counted',
    again: () => folder,
    restored: unread,
    tally: (plot, coverage) => ({
      t: 'groups',
      plot,
      coverage,
      ...fold.snapshot(),
    }),
  });
  expect(folder.cols).toStrictEqual([REGION, REVENUE]);
  const marks = HEADERS.map(() => 'point' as const);
  expect(folder.readsWith(marks)).toBe(false);
  expect(
    folder.readsWith(marks.map((m, col) => (col === REVENUE ? 'comma' : m))),
  ).toBe(true);
  const cells = ['', 'North', '', '', '', '1,5'];
  const shown = (col: number) => () => cells[col] ?? '';
  folder.fold(0, { from: 0, end: 2, shown });
  const after = cells.map((cell, col) => (col === REGION ? 'South' : cell));
  folder.move(0, 1, cells, after);
  expect(fold.snapshot().groups).toStrictEqual([
    { value: 'North', rows: 1, sum: 1.5 },
    { value: 'South', rows: 1, sum: 1.5 },
  ]);
  folder.unfold(0, { from: 0, end: 1, shown });
  expect(fold.snapshot().groups).toStrictEqual([
    { value: 'South', rows: 1, sum: 1.5 },
  ]);
});

test("a bars or pie chart's folder keeps the key a save names it by, and takes a block back as it folded it", () => {
  const plot = { t: 'pie', by: column(REGION), sum: column(REVENUE) } as const;
  const marks = HEADERS.map(() => 'point' as const);
  const folder = groupsFolder(plot, HEADERS, marks);
  if (typeof folder === 'string') throw new Error(`no column ${folder}`);
  expect(folder.key).toBe(`groups ${REGION} ${REVENUE}`);
  expect(folder.cols).toStrictEqual([REGION, REVENUE]);
  const shown = (col: number) => (row: number) => sales.display(row, col);
  const last = Math.floor((ROWS - 1) / TINY.blockRows);
  for (let block = 0; block <= last; block++) {
    const from = block * TINY.blockRows;
    folder.fold(block, {
      from,
      end: Math.min(from + TINY.blockRows, ROWS),
      shown,
    });
  }
  const kept = last * TINY.blockRows;
  folder.unfold(last, { from: kept, end: ROWS, shown });
  const coverage = { rows: kept, total: kept, complete: true };
  expect(folder.tally(plot, coverage)).toStrictEqual(pure(plot, sales, kept));
});

test("a scatter's folder keeps the key a save names it by, saves nothing an edit left stale, and mends it from the block alone", async () => {
  const plot = { t: 'scatter', x: column(UNITS), y: column(REVENUE) } as const;
  const marks = HEADERS.map(() => 'point' as const);
  const folder = sampleFolder(plot, HEADERS, marks);
  if (typeof folder === 'string') throw new Error(`no column ${folder}`);
  expect(folder.key).toBe(`sample ${UNITS} ${REVENUE}`);
  const whole = blocks(sales);
  for (let block = 0; block * TINY.blockRows < ROWS; block++) {
    folder.fold(block, await whole(block));
  }
  const sheet = read(NAME, bytes);
  const block = Math.floor(EDITED / TINY.blockRows);
  // The row is made the block's most, then taken back from it.
  for (const revenue of [ABOVE_ALL, '1']) {
    const before = shownRow(sheet, EDITED);
    sheet.set(EDITED, REVENUE, revenue);
    folder.move(block, EDITED, before, shownRow(sheet, EDITED));
  }
  expect(folder.saved()).toBeUndefined();
  await folder.mend(blocks(sheet));
  expect(folder.saved()).toBeDefined();
  expect(folder.tally(plot, WHOLE)).toStrictEqual(pure(plot, sheet));
});

test("a stacked chart's folder counts or sums by both its columns, moves by the one row an edit changed, and reads back from its save", async () => {
  const marks = HEADERS.map(() => 'point' as const);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, CHANNEL, 'mail');
  for (const sum of [undefined, column(REVENUE)]) {
    const plot = {
      t: 'stack',
      by: column(REGION),
      split: column(CHANNEL),
      ...(sum && { sum }),
    } as const;
    const folder = splitFolder(plot, HEADERS, marks);
    if (typeof folder === 'string') throw new Error(`no column ${folder}`);
    const cols =
      sum === undefined ? [REGION, CHANNEL] : [REGION, CHANNEL, REVENUE];
    expect(folder.key).toBe(`split ${cols.join(' ')}`);
    expect(folder.cols).toStrictEqual(cols);
    const whole = blocks(sales);
    for (let block = 0; block * TINY.blockRows < ROWS; block++) {
      folder.fold(block, await whole(block));
    }
    const block = Math.floor(EDITED / TINY.blockRows);
    folder.move(block, EDITED, before, shownRow(sheet, EDITED));
    // The pure fold of the edited sheet, row by row.
    const fold = new SplitFold(sum === undefined ? undefined : 'point');
    for (let r = 0; r < ROWS; r++) {
      const cell = sum === undefined ? '' : sheet.display(r, REVENUE);
      fold.add(sheet.display(r, REGION), sheet.display(r, CHANNEL), cell);
    }
    // A stack is no Plot yet, so the tally names the plot of a bar chart.
    const heard = REGION_ROWS.plot;
    const tally = { t: 'stack', plot: heard, coverage: WHOLE };
    expect(folder.tally(heard, WHOLE)).toStrictEqual({
      ...tally,
      ...fold.snapshot(),
    });
    const back = folder.restored(JSON.parse(JSON.stringify(folder.saved())));
    expect(back?.tally(heard, WHOLE)).toStrictEqual(folder.tally(heard, WHOLE));
    expect(folder.readsWith(marks)).toBe(true);
    const comma = marks.map(() => 'comma' as const);
    expect(folder.readsWith(comma)).toBe(sum === undefined);
  }
});

test('a stacked chart folded a block at a time reads as the pure fold of its rows by both columns, and reads back from a save with no pass', () => {
  const tallies = folded([STACKED, REVENUE_STACKED]);
  const both = [
    [STACKED.id, pure(STACKED.plot)],
    [REVENUE_STACKED.id, pure(REVENUE_STACKED.plot)],
  ];
  expect(tallies.read(ROWS, true)).toStrictEqual(both);
  const reopened = new Tallies();
  reopened.restore(JSON.parse(JSON.stringify(tallies.saved())), ROWS);
  for (const chart of [STACKED, REVENUE_STACKED])
    reopened.attach(chart, HEADERS);
  expect(reopened.from()).toBe(ROWS);
  expect(reopened.read(ROWS, true)).toStrictEqual(both);
  // Bars of the same column hold a fold of another key, so they fold anew.
  const bars: Chart = { ...STACKED, plot: { t: 'bars', by: column(REGION) } };
  reopened.attach(bars, HEADERS);
  expect(reopened.from()).toBe(0);
});

test('a chart of bars sends the values a person moved first, and a change of their order alone keeps its fold', () => {
  const tallies = folded([REGION_ROWS]);
  tallies.read(ROWS, true);
  for (const order of [['South', 'West'], ['North']]) {
    const plot: Plot = { t: 'bars', by: column(REGION), order };
    const moved: Chart = { ...REGION_ROWS, plot };
    tallies.attach(moved, HEADERS);
    expect(tallies.from()).toBe(ROWS);
    const tally = tallies.read(ROWS, true)[0]?.[1];
    expect(tally).toStrictEqual(pure(moved.plot));
    if (tally?.t !== 'groups') throw new Error('bars tally as groups');
    expect(
      tally.groups.slice(0, order.length).map((g) => g.value),
    ).toStrictEqual(order);
  }
  const split = column(CHANNEL);
  const plot: Plot = { t: 'stack', by: column(REGION), split, order: ['West'] };
  const stacked: Chart = { ...STACKED, plot };
  expect(folded([stacked]).read(ROWS, true)).toStrictEqual([
    [stacked.id, pure(stacked.plot)],
  ]);
});

test('an over-time chart folded a block at a time reads as the pure fold of its dates, and a change of size alone keeps its fold', () => {
  const tallies = folded([PER_MONTH, REVENUE_WEEKLY]);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [PER_MONTH.id, pure(PER_MONTH.plot)],
    [REVENUE_WEEKLY.id, pure(REVENUE_WEEKLY.plot)],
  ]);
  const daily: Chart = {
    ...PER_MONTH,
    plot: { t: 'time', at: column(DATES), per: 'day', order: 'day' },
  };
  tallies.attach(daily, HEADERS);
  expect(tallies.from()).toBe(ROWS);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [daily.id, pure(daily.plot)],
  ]);
  const plot = {
    t: 'time',
    at: column(DATES),
    per: 'day',
    order: 'month',
  } as const;
  tallies.attach({ ...PER_MONTH, plot }, HEADERS);
  expect(tallies.from()).toBe(0);
});

test('a histogram folded a block at a time reads as the pure spread of its numbers, and a change of span alone keeps its fold', () => {
  const tallies = folded([UNITS_SPREAD, REVENUE_SPREAD]);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [UNITS_SPREAD.id, pure(UNITS_SPREAD.plot)],
    [REVENUE_SPREAD.id, pure(REVENUE_SPREAD.plot)],
  ]);
  const every: Chart = {
    ...UNITS_SPREAD,
    plot: { t: 'histogram', of: column(UNITS), span: 'all' },
  };
  tallies.attach(every, HEADERS);
  expect(tallies.from()).toBe(ROWS);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [every.id, pure(every.plot)],
  ]);
  // Bars of the same column hold a fold of another key, so they fold anew.
  tallies.attach({ ...every, plot: { t: 'bars', by: column(UNITS) } }, HEADERS);
  expect(tallies.from()).toBe(0);
});

test("a box plot folded a block at a time reads as the pure spread of its numbers, and shares a histogram's fold of its column", () => {
  const tallies = folded([UNITS_BOX]);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [UNITS_BOX.id, pure(UNITS_BOX.plot)],
  ]);
  tallies.attach({ ...UNITS_SPREAD, id: UNITS_BOX.id }, HEADERS);
  expect(tallies.from()).toBe(ROWS);
});

test('a box plot by a column folded a block at a time reads as the pure spread of each value', () => {
  const tallies = folded([REVENUE_BOXES]);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [REVENUE_BOXES.id, pure(REVENUE_BOXES.plot)],
  ]);
});

test('an edit moves a box plot by a column by its one row, and a save keeps the fold, which reads back with no pass', async () => {
  const tallies = folded([REVENUE_BOXES]);
  tallies.read(ROWS, true);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, REVENUE, '123456');
  const block = Math.floor(EDITED / TINY.blockRows);
  const moved = tallies.cell(block, EDITED, before, shownRow(sheet, EDITED));
  await tallies.mend(moved, blocks(sheet));
  const edited = [[REVENUE_BOXES.id, pure(REVENUE_BOXES.plot, sheet)]];
  expect(tallies.read(ROWS, true)).toStrictEqual(edited);
  const reopened = new Tallies();
  reopened.restore(JSON.parse(JSON.stringify(tallies.saved())), ROWS);
  reopened.attach(REVENUE_BOXES, HEADERS);
  expect(reopened.from()).toBe(ROWS);
  expect(reopened.read(ROWS, true)).toStrictEqual(edited);
});

test("dots of a mean folded a block at a time read as the pure mean fold of their column, which a sum's does not share", () => {
  const tallies = folded([CHANNEL_MEANS]);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [CHANNEL_MEANS.id, pure(CHANNEL_MEANS.plot)],
  ]);
  const [by, of] = [column(CHANNEL), column(UNITS)];
  tallies.attach(
    { ...CHANNEL_MEANS, plot: { t: 'dots', by, of, measure: 'sum' } },
    HEADERS,
  );
  expect(tallies.from()).toBe(0);
});

test('an edit moves dots of a mean by its one row, and a save keeps the fold, which reads back with no pass', async () => {
  const tallies = folded([CHANNEL_MEANS]);
  tallies.read(ROWS, true);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, UNITS, 'n/a');
  const block = Math.floor(EDITED / TINY.blockRows);
  const moved = tallies.cell(block, EDITED, before, shownRow(sheet, EDITED));
  await tallies.mend(moved, blocks(sheet));
  const edited = [[CHANNEL_MEANS.id, pure(CHANNEL_MEANS.plot, sheet)]];
  expect(tallies.read(ROWS, true)).toStrictEqual(edited);
  const saved = tallies.saved();
  expect(saved[CHANNEL_MEANS.id]?.key).toBe(`mean ${CHANNEL} ${UNITS}`);
  const reopened = new Tallies();
  reopened.restore(JSON.parse(JSON.stringify(saved)), ROWS);
  reopened.attach(CHANNEL_MEANS, HEADERS);
  expect(reopened.from()).toBe(ROWS);
  expect(reopened.read(ROWS, true)).toStrictEqual(edited);
});

test('a slope folded a block at a time reads as the pure split fold of its two states, and another From or To, or a mean, reads no block', () => {
  const tallies = folded([CHANNEL_SLOPE]);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [CHANNEL_SLOPE.id, pure(CHANNEL_SLOPE.plot)],
  ]);
  const plot: SlopePlot = {
    ...WEB_TO_DIRECT,
    from: 'partner',
    measure: 'mean',
  };
  tallies.attach({ ...CHANNEL_SLOPE, plot }, HEADERS);
  expect(tallies.from()).toBe(ROWS);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [CHANNEL_SLOPE.id, pure(plot)],
  ]);
});

test("dots of rows or a sum share a bar chart's fold, and read as its pure fold", () => {
  const [by, of] = [column(CHANNEL), column(UNITS)];
  const pairs: Array<[Plot, Plot]> = [
    [
      { t: 'bars', by },
      { t: 'dots', by },
    ],
    [
      { t: 'bars', by, sum: of },
      { t: 'dots', by, of, measure: 'sum', order: ['web'] },
    ],
  ];
  for (const [bars, plot] of pairs) {
    const tallies = folded([{ ...REGION_ROWS, plot: bars }]);
    tallies.attach({ ...REGION_ROWS, plot }, HEADERS);
    expect(tallies.from()).toBe(ROWS);
    expect(tallies.read(ROWS, true)).toStrictEqual([
      [REGION_ROWS.id, pure(plot)],
    ]);
  }
});

test('an edit to a number moves a histogram by its one row, and a save keeps the fold, which reads back with no pass', async () => {
  const tallies = folded([UNITS_SPREAD]);
  tallies.read(ROWS, true);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, UNITS, '123456');
  const block = Math.floor(EDITED / TINY.blockRows);
  const moved = tallies.cell(block, EDITED, before, shownRow(sheet, EDITED));
  await tallies.mend(moved, blocks(sheet));
  const edited = [[UNITS_SPREAD.id, pure(UNITS_SPREAD.plot, sheet)]];
  expect(tallies.read(ROWS, true)).toStrictEqual(edited);
  expect(edited).not.toStrictEqual([
    [UNITS_SPREAD.id, pure(UNITS_SPREAD.plot)],
  ]);
  const reopened = new Tallies();
  reopened.restore(JSON.parse(JSON.stringify(tallies.saved())), ROWS);
  reopened.attach(UNITS_SPREAD, HEADERS);
  expect(reopened.from()).toBe(ROWS);
  expect(reopened.read(ROWS, true)).toStrictEqual(edited);
});

test('an edit to a date moves an over-time chart by its one row, and a save keeps the fold, which reads back with no pass', async () => {
  const tallies = folded([REVENUE_WEEKLY]);
  tallies.read(ROWS, true);
  const sheet = read(NAME, bytes);
  const before = shownRow(sheet, EDITED);
  sheet.set(EDITED, DATES, LATER);
  const block = Math.floor(EDITED / TINY.blockRows);
  const moved = tallies.cell(block, EDITED, before, shownRow(sheet, EDITED));
  await tallies.mend(moved, blocks(sheet));
  const edited = [[REVENUE_WEEKLY.id, pure(REVENUE_WEEKLY.plot, sheet)]];
  expect(tallies.read(ROWS, true)).toStrictEqual(edited);
  const reopened = new Tallies();
  reopened.restore(JSON.parse(JSON.stringify(tallies.saved())), ROWS);
  reopened.attach(REVENUE_WEEKLY, HEADERS);
  expect(reopened.from()).toBe(ROWS);
  expect(reopened.read(ROWS, true)).toStrictEqual(edited);
});

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

test('a tally names the plot it reads, and a chart that keeps its fold under another plot names that one', () => {
  const tallies = folded([REGION_ROWS]);
  tallies.read(ROWS, true);
  const plot: Plot = { t: 'pie', by: column(REGION) };
  tallies.attach({ ...REGION_ROWS, plot }, HEADERS);
  expect(tallies.from()).toBe(ROWS);
  expect(tallies.read(ROWS, true)).toStrictEqual([
    [REGION_ROWS.id, pure(plot)],
  ]);
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

test('a chart over a column whose decimal mark changed folds again from its first row, with the mark now, and one over the others keeps its fold', () => {
  const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
  const tallies = folded(charts);
  const marks = HEADERS.map(() => 'point' as const);
  expect(tallies.remark(marks)).toBe(false);
  expect(tallies.from()).toBe(ROWS);
  const comma = marks.map((m, col) => (col === UNITS ? 'comma' : m));
  expect(tallies.remark(comma)).toBe(true);
  expect(tallies.from()).toBe(0);
  const rows = tallies
    .read(ROWS, true)
    .map(([id, t]) => [id, t.t === 'unread' ? undefined : t.coverage.rows]);
  expect(rows).toEqual([
    [REGION_ROWS.id, ROWS],
    [REGION_REVENUE.id, ROWS],
    [UNITS_REVENUE.id, 0],
  ]);
  // Attached again, the scatter keeps the fold it made with the mark now.
  tallies.attach(UNITS_REVENUE, HEADERS);
  expect(tallies.remark(comma)).toBe(false);
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

test('an append takes over each fold less the last block, which it folds again with the rows that follow, and each chart is pending until it has them', () => {
  const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
  const was = folded(charts, ROWS_BEFORE);
  was.read(ROWS_BEFORE, true);
  const last = Math.floor((ROWS_BEFORE - 1) / TINY.blockRows);
  const kept = last * TINY.blockRows;
  const shown = (col: number) => (row: number) => sales.display(row, col);
  const tallies = new Tallies();
  tallies.adopt(was, last, { from: kept, end: ROWS_BEFORE, shown });
  expect(was.from()).toBeUndefined();
  for (const chart of charts) tallies.attach(chart, HEADERS);
  expect(tallies.from()).toBe(kept);
  const pending = { coverage: { rows: kept, total: ROWS, complete: false } };
  const partial = charts.map((chart) => [chart.id, pending]);
  expect(tallies.read(ROWS, false)).toMatchObject(partial);
  // The last block grows into the rows that follow, and more follow it.
  for (let from = kept, block = last; from < ROWS; block++) {
    const end = Math.min(from + TINY.blockRows, ROWS);
    tallies.fold(block, from, end, shown);
    from = end;
  }
  const whole = charts.map((chart) => [chart.id, pure(chart.plot)]);
  expect(tallies.read(ROWS, true)).toStrictEqual(whole);
});

test('a fold taken over by a view whose headers put the columns elsewhere is not kept', () => {
  const last = Math.floor((ROWS_BEFORE - 1) / TINY.blockRows);
  const shown = (col: number) => (row: number) => sales.display(row, col);
  const block = { from: last * TINY.blockRows, end: ROWS_BEFORE, shown };
  const tallies = new Tallies();
  tallies.adopt(folded([REGION_ROWS], ROWS_BEFORE), last, block);
  tallies.attach(REGION_ROWS, [...HEADERS].reverse());
  expect(tallies.from()).toBe(0);
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
  const { id, plot } = UNITS_REVENUE;
  const unread = [[id, { t: 'unread', plot, said }]];
  expect(tallies.unread(said, moved)).toStrictEqual(unread);
  const pending = tallies.read(ROWS, true).map(([id]) => id);
  expect(pending).toEqual([REGION_ROWS.id]);
});

test('each chart of a .uno hears its fold of every row, as the pure fold reads it', async () => {
  const { engine, done } = connect(TINY);
  try {
    const charts = [
      REGION_ROWS,
      REGION_REVENUE,
      UNITS_REVENUE,
      PER_MONTH,
      REVENUE_STACKED,
    ];
    const heard = new Heard(await opened(engine, charts));
    const lasts = charts.map((chart) => heard.of(chart.id));
    for (const [i, chart] of charts.entries()) {
      expect(await lasts[i]).toStrictEqual(pure(chart.plot));
    }
  } finally {
    done();
  }
});

test("an over-time chart's later batches come by size and offset, as its fold holds them, and a chart with none or no chart answers so", async () => {
  const { engine, done } = connect(TINY);
  try {
    const charts = [REGION_ROWS, PER_MONTH];
    const heard = new Heard(await opened(engine, charts));
    await Promise.all(charts.map((chart) => heard.of(chart.id)));
    const fold = new TimeFold('day');
    for (let r = 0; r < ROWS; r++) fold.add(sales.display(r, DATES));
    const later = await engine.batch(PER_MONTH.id, 'hour', LEVEL_BATCH);
    expect(later).toStrictEqual(fold.batch('hour', LEVEL_BATCH));
    expect(later?.offset).toBe(LEVEL_BATCH);
    const past = later!.span;
    expect(await engine.batch(PER_MONTH.id, 'hour', past)).toBeUndefined();
    expect(await engine.batch(REGION_ROWS.id, 'day', 0)).toBeUndefined();
    await expect(engine.batch('c9', 'day', 0)).rejects.toThrow('c9');
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
    expect(await one).toStrictEqual({
      ...pure(REGION_ROWS.plot),
      plot: moved.plot,
    });
    const unread = ({ plot }: Chart, header: string) => ({
      t: 'unread',
      plot,
      said: { t: 'chart-column-gone', header, name: NAME },
    });
    expect(await two).toStrictEqual(unread(gone, 'margin'));
    expect(await three).toStrictEqual(unread(also, 'cost'));
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
    const unread = charts.map(({ id, plot }) => [
      id,
      { t: 'unread', plot, said },
    ]);
    expect(await Promise.all(lasts)).toStrictEqual(unread.map(([, t]) => t));
    // A round trip, after which anything posted before it has landed.
    await src.rows(0, 1);
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

test('a chart uncharted before its view is announced is not heard from', async () => {
  const { engine, done } = connect(TINY);
  try {
    const plot: Plot = { t: 'bars', by: { col: REGION, header: 'margin' } };
    const was = await opened(engine, [{ ...REGION_ROWS, plot }]);
    // The relink's answer announces its view, and the unchart runs before it.
    const relinked = engine
      .relink(was, FILE)
      .then((src) => ({ src, heard: new Heard(src) }));
    await engine.unchart(REGION_ROWS.id);
    const { src, heard } = await relinked;
    // A round trip, after which anything posted before it has landed.
    await src.rows(0, 1);
    expect(heard.all).toStrictEqual([]);
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

test('an append keeps the folds of the rows it kept, so each chart hears a partial tally over at least them while the new file is read, then its complete one over every part, with no read of the rows kept', async () => {
  const hold = holding(THIRD.path);
  const single = [hold.provider, blobProvider()];
  const { engine, done } = connect(TINY, [...single, multiProvider(single)]);
  try {
    const before = await openOne(engine, FIRST_TWO);
    const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE].map(
      (chart) => ({ ...chart, source: before.id }),
    );
    const first = new Heard(before);
    const lasts = charts.map((chart) => first.of(chart.id));
    for (const chart of charts) await engine.chart(chart);
    for (const last of lasts) await last;

    const reads = hold.reads();
    hold.arm();
    const src = await engine.append(before, [THIRD]);
    const heard = new Heard(src);
    const again = charts.map((chart) => heard.of(chart.id));
    await hold.held;
    await sleep(TALLY_MS);
    hold.release();
    for (const [i, chart] of charts.entries()) {
      expect(await again[i]).toStrictEqual(pure(chart.plot));
    }
    // A view that folded the kept rows again would read each of their blocks.
    const blocksKept = Math.ceil(ROWS_BEFORE / TINY.blockRows);
    expect(hold.reads() - reads).toBeLessThan(blocksKept);
    // The first tallies heard are partial, over at least the kept rows: the
    // rows before the append less its last block, which is read again.
    for (const [, partial] of heard.all.slice(0, charts.length)) {
      if (partial.t === 'unread') throw new Error('a first tally is unread');
      expect(partial.coverage.complete).toBe(false);
      expect(partial.coverage.rows).toBeGreaterThanOrEqual(
        ROWS_BEFORE - TINY.blockRows,
      );
      expect(partial.coverage.rows).toBeLessThan(ROWS);
    }
  } finally {
    done();
  }
});

test('an append keeps the edits of the rows it kept in the folds it takes over, so each chart hears its complete tally with them, as the new view shows them', async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const before = await openOne(engine, FIRST_TWO);
    const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE].map(
      (chart) => ({ ...chart, source: before.id }),
    );
    const first = new Heard(before);
    const lasts = charts.map((chart) => first.of(chart.id));
    for (const chart of charts) await engine.chart(chart);
    for (const last of lasts) await last;
    engine.mode(true);
    // The source's last row, in the block the append reads again.
    const row = ROWS_BEFORE - 1;
    const sheet = read(NAME, bytes);
    const set = { op: Op.Set, row, col: REVENUE, now: '1' };
    const note = { op: Op.Note, row, col: REGION, now: 'x^2' };
    for (const req of [set, note]) {
      sheet.replay([(await before.edit(req)).edit]);
    }

    const src = await engine.append(before, [THIRD]);
    const heard = new Heard(src);
    const again = charts.map((chart) => heard.of(chart.id));
    for (const [i, chart] of charts.entries()) {
      expect(await again[i]).toStrictEqual(pure(chart.plot, sheet));
    }
    expect((await src.rows(row, 1)).rows[0]).toEqual(shownRow(sheet, row));
  } finally {
    done();
  }
});

test('an append refused once its charts took the folds over gives them back, so the source kept hears its charts again, and after an edit', async () => {
  const hold = holding(part(0).path);
  const single = [hold.provider, blobProvider()];
  const { engine, done } = connect(TINY, [...single, multiProvider(single)]);
  try {
    const before = await openOne(engine, FIRST_TWO);
    const chart = { ...REGION_REVENUE, source: before.id };
    const heard = new Heard(before);
    let last = heard.of(chart.id);
    await engine.chart(chart);
    await last;

    // The new view's read of its sample rows, after the folds are taken over.
    const said: Said = { t: 'changed-on-disk', name: part(0).name };
    hold.arm(new Refusal(said));
    last = heard.of(chart.id);
    await expect(engine.append(before, [THIRD])).rejects.toThrow(
      'changed on disk after it was opened',
    );
    expect(before.progress.rows).toBe(ROWS_BEFORE);
    expect(await last).toStrictEqual(pure(chart.plot, sales, ROWS_BEFORE));

    engine.mode(true);
    const sheet = read(NAME, bytes);
    last = heard.of(chart.id);
    const set = { op: Op.Set, row: EDITED, col: REVENUE, now: '1' };
    sheet.replay([(await before.edit(set)).edit]);
    expect(await last).toStrictEqual(pure(chart.plot, sheet, ROWS_BEFORE));
  } finally {
    done();
  }
});

test('a source pointed at another file folds its charts over that file alone, keeping nothing of the one it left', async () => {
  const { engine, done } = connect(TINY);
  try {
    const was = await opened(engine, [REGION_REVENUE]);
    await new Heard(was).of(REGION_REVENUE.id);
    const src = await engine.relink(was, part(0));
    const last = new Heard(src).of(REGION_REVENUE.id);
    const plot = REGION_REVENUE.plot;
    expect(await last).toStrictEqual(pure(plot, sales, PART_ROWS));
  } finally {
    done();
  }
});

test('an edit moves each chart that reads its column by the one row, which hears its complete tally again, undo and redo move it back and forth, and a chart over another column is not heard from', async () => {
  const { engine, done } = connect(TINY);
  try {
    const charts = [REGION_ROWS, REGION_REVENUE, UNITS_REVENUE];
    const src = await opened(engine, charts);
    const heard = new Heard(src);
    for (const last of charts.map((chart) => heard.of(chart.id))) await last;
    const settled = heard.all.length;
    engine.mode(true);
    const sheet = read(NAME, bytes);
    const moved = async (
      over: Chart[],
      change: () => Promise<unknown>,
      of: Sheet,
    ) => {
      const lasts = over.map((chart) => heard.of(chart.id));
      await change();
      for (const [i, chart] of over.entries()) {
        expect(await lasts[i]).toStrictEqual(pure(chart.plot, of));
      }
    };
    const edit = async (req: EditRequest) =>
      sheet.replay([(await src.edit(req)).edit]);
    const revenue = [REGION_REVENUE, UNITS_REVENUE];
    const set = { op: Op.Set, row: EDITED, col: REVENUE, now: ABOVE_ALL };
    await moved(revenue, () => edit(set), sheet);
    await moved(revenue, () => src.undo(), sales);
    await moved(revenue, () => src.redo(), sheet);
    const region = [REGION_ROWS, REGION_REVENUE];
    const note = { op: Op.Note, row: EDITED, col: REGION, now: 'x^2' };
    await moved(region, () => edit(note), sheet);
    // A round trip, after which anything posted before it has landed.
    await src.rows(0, 1);
    const ids = (over: Chart[]) => over.map((chart) => chart.id);
    const once = [revenue, revenue, revenue, region].flatMap(ids);
    expect(heard.all.slice(settled).map(([chart]) => chart)).toEqual(once);
  } finally {
    done();
  }
});

test('an edit while the source is being read moves a chart by a row it has folded, before the pass or ahead of it, leaves a row of the block being read and one beyond it to the pass, and no row is counted twice', async () => {
  const hold = holding();
  const { engine, done } = connect(TINY, [hold.provider, blobProvider()]);
  try {
    const src = await opened(engine, [REGION_REVENUE]);
    const last = new Heard(src).of(REGION_REVENUE.id);
    hold.arm();
    // The first row of the block whose read is held, after the ones the
    // pass has folded, and the first of the block beyond it.
    const held = rowAt(await hold.held);
    expect(held).toBeGreaterThan(EDITED);
    const beyond = held + TINY.blockRows;
    await indexed(src);
    engine.mode(true);
    const sheet = read(NAME, bytes);
    const log = [];
    for (const row of [EDITED, held, beyond, LAST_ROW]) {
      const set = { op: Op.Set, row, col: REVENUE, now: ABOVE_ALL };
      log.push((await src.edit(set)).edit);
    }
    sheet.replay(log);
    hold.release();
    expect(await last).toStrictEqual(pure(REGION_REVENUE.plot, sheet));
  } finally {
    done();
  }
});

test('an edit over a whole column folds the charts that read it again, through a formula too, and a chart over another column is not heard from', async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, FILE);
    engine.mode(true);
    const heard = new Heard(src);
    const sum = (col: number): Plot => {
      return { t: 'bars', by: column(REGION), sum: column(col) };
    };
    const units = {
      ...REGION_ROWS,
      id: 'c2',
      source: src.id,
      plot: sum(UNITS),
    };
    const channel = { ...units, id: 'c3', plot: sum(CHANNEL) };
    const charts = [{ ...REGION_ROWS, source: src.id }, units, channel];
    const lasts = charts.map((chart) => heard.of(chart.id));
    for (const chart of charts) await engine.chart(chart);
    for (const last of lasts) await last;
    const settled = heard.all.length;
    const log: Edit[] = [];
    const refolded = async (over: Chart[], change: () => Promise<unknown>) => {
      const lasts = over.map((chart) => heard.of(chart.id));
      await change();
      const sheet = read(NAME, bytes);
      sheet.replay(log);
      for (const [i, chart] of over.entries()) {
        expect(await lasts[i]).toStrictEqual(pure(chart.plot, sheet));
      }
    };
    const edit = (req: EditRequest) => async () => {
      log.push((await src.edit(req)).edit);
    };
    const bind = { op: Op.Bind, row: NO_ROW, col: CHANNEL, now: 'units / 2' };
    await refolded([channel], edit(bind));
    const program = 'replace(/,/, "")';
    const apply = { op: Op.Apply, row: NO_ROW, col: UNITS, now: program };
    await refolded([units, channel], edit(apply));
    const unbind = { op: Op.Unbind, row: NO_ROW, col: CHANNEL, now: '' };
    await refolded([channel], edit(unbind));
    await refolded([channel], () => src.undo().then(() => log.pop()));
    // A round trip, after which anything posted before it has landed.
    await src.rows(0, 1);
    const ids = new Set(heard.all.slice(settled).map(([chart]) => chart));
    expect([...ids]).toEqual([channel.id, units.id]);
  } finally {
    done();
  }
});

test('a chart sums a column with the decimal mark its sample shows, and folds again when an edit changes the mark', async () => {
  const { engine, done } = connect(TINY);
  try {
    const csv =
      'region;amount\nNorth;1,5\nNorth;2,25\nSouth;1.234,56\nSouth;0,75\n';
    const blob = new Blob([csv]);
    const src = await openOne(engine, { name: 'eu.csv', blob });
    expect(src.opened.columns[1]!.mark).toBe('comma');
    const at = (col: number, header: string) => ({ col, header });
    const plot: Plot = { t: 'bars', by: at(0, 'region'), sum: at(1, 'amount') };
    const heard = new Heard(src);
    const sums = async (change: () => Promise<unknown>) => {
      const last = heard.of(REGION_ROWS.id);
      await change();
      const tally = await last;
      if (tally.t !== 'groups') throw new Error(`heard ${tally.t}`);
      return tally.groups.map(({ value, sum }) => [value, sum]);
    };
    const chart = { ...REGION_ROWS, source: src.id, plot };
    expect(await sums(() => engine.chart(chart))).toEqual([
      ['South', 1235.31],
      ['North', 3.75],
    ]);
    // A point decimal in the sample makes the column read as it always has.
    engine.mode(true);
    const set = { op: Op.Set, row: 0, col: 1, now: '0.5' };
    expect(await sums(() => src.edit(set))).toEqual([
      ['North', 225.5],
      ['South', 76.23456],
    ]);
  } finally {
    done();
  }
});

test('a chart over a formula sums what it computes from a column with its decimal mark, and folds again when an edit changes the mark', async () => {
  const { engine, done } = connect(TINY);
  try {
    const blob = new Blob(['region;amount;double\nNorth;1,5;\nSouth;2,25;\n']);
    const src = await openOne(engine, { name: 'eu.csv', blob });
    engine.mode(true);
    const bind = { op: Op.Bind, row: NO_ROW, col: 2, now: 'amount * 2' };
    const { columns } = await src.edit(bind);
    expect(columns.map((c) => [c.kind, c.mark])).toEqual([
      ['text', 'point'],
      ['num', 'comma'],
      ['num', 'point'],
    ]);
    const at = (col: number, header: string) => ({ col, header });
    const plot: Plot = { t: 'bars', by: at(0, 'region'), sum: at(2, 'double') };
    const heard = new Heard(src);
    const sums = async (change: () => Promise<unknown>) => {
      const last = heard.of(REGION_ROWS.id);
      await change();
      const tally = await last;
      if (tally.t !== 'groups') throw new Error(`heard ${tally.t}`);
      return tally.groups.map(({ value, sum }) => [value, sum]);
    };
    const chart = { ...REGION_ROWS, source: src.id, plot };
    expect(await sums(() => engine.chart(chart))).toEqual([
      ['South', 4.5],
      ['North', 3],
    ]);
    // South's row is not edited, but what its formula reads is.
    const set = { op: Op.Set, row: 0, col: 1, now: '0.5' };
    expect(await sums(() => src.edit(set))).toEqual([
      ['South', 450],
      ['North', 1],
    ]);
    expect((await src.rows(1, 1)).rows).toEqual([['South', '2,25', '450']]);
  } finally {
    done();
  }
});
