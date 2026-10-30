/**
 * @fileoverview A Parquet file read by the engine: a workspace that says a
 * source was read as Parquet reopens it so, as its CSV twin reads, each
 * pinned column found by its key and each logged edit on its cell, its
 * blocks planned from its row count and complete from the start, and a
 * save records it so. A block of a paged row group reads alone, and one of
 * an unpaged group with its window, sized to its heaviest rows, once while
 * the rows are scrolled, and the cache holds them within its budget as
 * text.
 */

import { expect, test, vi } from 'vite-plus/test';

import {
  READ_VERSION,
  newManifest,
  readContainer,
  writeDocument,
} from '@document';
import type { Held, SavedColumn } from '@document';
import { TUNING, english } from '@engine';
import type { Engine } from '@engine';
import { openReading } from '@engine/reading';
import {
  DECODE_WINDOW_BYTES,
  MAX_WINDOW_BLOCKS,
  PlannedIndex,
  TablePages,
} from '@engine/table';
import type { TableRows } from '@engine/table';
import type { Table } from '@ingest';
import { Op, Sheet } from '@sheet';
import { bytesSource } from '@store';
import { multiFiles } from '@store/multi';
import { localFiles } from '@store/node';
import {
  SALES,
  UNPAGED_STRINGS,
  opened,
  salesRows,
  unpaged,
  unpagedRow,
} from '@core-tests/ingest/parquet/tables';
import { ROWS } from '@core-tests/testdata/sales-q3';
import {
  SCREEN,
  TINY,
  connect,
  everyRow,
  multiProviders,
  openOne,
  saidIn,
  testdata,
} from './harness.ts';

/** A planned file's rows and stored bytes, and the rows in its blocks. */
const PLAN = { rows: 30, size: 4096, blockRows: 7 };
/** The block holding PLAN's last two rows. */
const LAST_BLOCK = 4;
/** The sales fixture's name and path on disk. */
const SALES_NAME = 'sales-q3.snappy.parquet';
const SALES_PATH = testdata(SALES_NAME);
/** The sales fixture's columns, in the file's order. */
const SALES_COLUMNS = ['date', 'region', 'rep', 'channel', 'units', 'revenue'];

/** Where SALES_COLUMNS has no column of a name. */
const ABSENT = -1;

/** A row of the sales fixture, with the cells of the columns `names` names. */
function under(names: readonly string[], row: readonly string[]): string[] {
  return names.map((name) => {
    const i = SALES_COLUMNS.indexOf(name);
    return i === ABSENT ? '' : row[i]!;
  });
}

test('a planned index has every row readable at once, in blocks of blockRows', () => {
  const { rows, size, blockRows } = PLAN;
  const index = new PlannedIndex(rows, size, blockRows);
  expect(index.complete).toBe(true);
  expect(index.readable()).toBe(rows);
  expect(index.rows()).toBe(rows);
  expect(index.indexed()).toEqual({ done: size, total: size });
  expect(index.blocks).toBe(LAST_BLOCK + 1);
  expect(index.blockOf(0)).toBe(0);
  expect(index.blockOf(blockRows - 1)).toBe(0);
  expect(index.blockOf(blockRows)).toBe(1);
  expect(index.blockOf(rows - 1)).toBe(LAST_BLOCK);
  expect(index.rowsOf(1)).toEqual([blockRows, 2 * blockRows]);
  // The last block holds what is left.
  expect(index.rowsOf(LAST_BLOCK)).toEqual([LAST_BLOCK * blockRows, rows]);
});

test('a planned index of no rows has no blocks', () => {
  const index = new PlannedIndex(0, PLAN.size, PLAN.blockRows);
  expect(index.readable()).toBe(0);
  expect(index.blocks).toBe(0);
  expect(index.indexed()).toEqual({ done: PLAN.size, total: PLAN.size });
});

/** Reads asked of a table, as [start, end) rows. */
type Reads = Array<[start: number, end: number]>;

/**
 * A table whose rows are one cell, by default the row's number, which is
 * paged or not and takes `bytesPerRow` uncompressed.
 */
function planned(
  paged: boolean,
  bytesPerRow: number | TableRows['bytesPerRow'],
  cell: (row: number) => string = String,
): { rows: TableRows; reads: Reads } {
  const reads: Reads = [];
  const rows: TableRows = {
    read: (start, end) => {
      reads.push([start, end]);
      const cells = Array.from({ length: end - start }, (_, i) => [
        cell(start + i),
      ]);
      return Promise.resolve(cells);
    },
    paged: () => paged,
    bytesPerRow:
      typeof bytesPerRow === 'number' ? () => bytesPerRow : bytesPerRow,
  };
  return { rows, reads };
}

/** `table` with each read it is asked for logged in `reads`. */
function counted(table: Table): { rows: TableRows; reads: Reads } {
  const reads: Reads = [];
  const rows: TableRows = {
    read: (start, end) => {
      reads.push([start, end]);
      return table.read(start, end);
    },
    paged: (start, end) => table.paged(start, end),
    bytesPerRow: (start, end) => table.bytesPerRow(start, end),
  };
  return { rows, reads };
}

/** Pages over `table` of `count` rows, through `tuning`'s blocks and cache. */
function pagesOver(
  table: TableRows,
  count: number,
  tuning = TUNING,
): { pages: TablePages; index: PlannedIndex } {
  const index = new PlannedIndex(count, PLAN.size, tuning.blockRows);
  const pages = new TablePages('t.parquet', table, index, tuning.cacheBytes);
  return { pages, index };
}

/** The byte that ends each cell as delimited text. */
const CELL_END_BYTES = 1;

/** The bytes `rows` would take as delimited text, as the cache counts them. */
function asText(rows: readonly string[][]): number {
  return rows
    .flat()
    .reduce((sum, cell) => sum + cell.length + CELL_END_BYTES, 0);
}

/** The sales fixture's table. */
function sales(): Promise<Table> {
  return opened(SALES_NAME, SALES);
}

test('a block of a paged row group reads alone', async () => {
  const { rows, reads } = planned(true, DECODE_WINDOW_BYTES);
  const { pages } = pagesOver(rows, PLAN.rows, TINY);
  const second = Array.from({ length: TINY.blockRows }, (_, i) => [
    String(TINY.blockRows + i),
  ]);
  expect(await pages.records(1)).toEqual(second);
  expect(reads).toEqual([[TINY.blockRows, 2 * TINY.blockRows]]);
});

test('a window holds the blocks DECODE_WINDOW_BYTES of their row group does, aligned', async () => {
  const blocks = 4;
  const bytesPerRow = DECODE_WINDOW_BYTES / (blocks * TINY.blockRows);
  const { rows, reads } = planned(false, bytesPerRow);
  const { pages } = pagesOver(rows, PLAN.rows, TINY);
  // Blocks 1 and 3 are in the window of blocks 0 to 3, and block 4 in the last.
  await pages.records(1);
  await pages.records(3);
  await pages.records(LAST_BLOCK);
  expect(reads).toEqual([
    [0, blocks * TINY.blockRows],
    [blocks * TINY.blockRows, PLAN.rows],
  ]);
});

test('a block of an unpaged row group whose rows fill a window decodes alone', async () => {
  const { rows, reads } = planned(false, DECODE_WINDOW_BYTES);
  const { pages } = pagesOver(rows, PLAN.rows, TINY);
  await pages.records(2);
  expect(reads).toEqual([[2 * TINY.blockRows, 3 * TINY.blockRows]]);
});

/** A table's rows: a light row group, then a far heavier one from `heavyFrom`. */
const UNEVEN = { rows: 40_000, heavyFrom: 3_000, light: 4, heavy: 4096 };

test('a window is sized by the heaviest row group under its rows', async () => {
  const { rows: count, heavyFrom, light, heavy } = UNEVEN;
  const { rows, reads } = planned(false, (_, end) =>
    end > heavyFrom ? heavy : light,
  );
  const { pages } = pagesOver(rows, count);
  await pages.records(0);
  // Block 0 lies in the light group, but a window of MAX_WINDOW_BLOCKS
  // sized by it alone would take more than three times DECODE_WINDOW_BYTES.
  const end =
    (DECODE_WINDOW_BYTES / (heavy * TUNING.blockRows)) * TUNING.blockRows;
  expect(reads).toEqual([[0, end]]);
  const bytes = heavyFrom * light + (end - heavyFrom) * heavy;
  expect(bytes).toBeLessThanOrEqual(DECODE_WINDOW_BYTES);
});

/** The text bytes of each row of a table whose text far outweighs its stored bytes. */
const TEXT_ROW_BYTES = 4096;

test('a window whose text outgrows the cache decodes once, and the next is sized by that text', async () => {
  const count = UNEVEN.rows;
  const cell = 'x'.repeat(TEXT_ROW_BYTES - CELL_END_BYTES);
  const { rows, reads } = planned(false, UNEVEN.light, () => cell);
  const { pages, index } = pagesOver(rows, count);
  for (let first = 0; first < count; first += SCREEN) {
    expect(await pages.rows(first, SCREEN)).toHaveLength(
      Math.min(SCREEN, count - first),
    );
    expect(pages.held).toBeLessThanOrEqual(TUNING.cacheBytes);
  }
  // The first window's text is more than the cache holds, so the cache
  // lets its first blocks go, and they are read from the window itself.
  const firstText = MAX_WINDOW_BLOCKS * TUNING.blockRows * TEXT_ROW_BYTES;
  expect(firstText).toBeGreaterThan(TUNING.cacheBytes);
  const after = DECODE_WINDOW_BYTES / (TEXT_ROW_BYTES * TUNING.blockRows);
  const windows: Reads = [[0, MAX_WINDOW_BLOCKS * TUNING.blockRows]];
  for (let b = MAX_WINDOW_BLOCKS; b < index.blocks; b += after) {
    const [start] = index.rowsOf(b);
    const [, end] = index.rowsOf(Math.min(b + after, index.blocks) - 1);
    windows.push([start, end]);
  }
  expect(reads).toEqual(windows);
});

test('the sales fixture reads as sales-q3.csv does, every window once', async () => {
  const { rows, reads } = counted(await sales());
  const want = salesRows();
  const { pages, index } = pagesOver(rows, want.length, TINY);
  expect(await pages.rows(0, want.length)).toEqual(want);
  expect(reads).toHaveLength(Math.ceil(index.blocks / MAX_WINDOW_BLOCKS));
});

/** The rows of a generated row group with no page index. */
const LONG_ROWS = 200_000;

test('a 200,000-row group with no page index decodes one window per MAX_WINDOW_BLOCKS blocks, and each string once, as it scrolls', async () => {
  const table = await opened('long.parquet', unpaged(LONG_ROWS));
  expect([table.groups, table.paged(0, LONG_ROWS)]).toEqual([1, false]);
  const span = MAX_WINDOW_BLOCKS * TUNING.blockRows;
  // Its rows are small enough for a window of MAX_WINDOW_BLOCKS.
  expect(table.bytesPerRow(0, LONG_ROWS) * span).toBeLessThan(
    DECODE_WINDOW_BYTES,
  );

  const { rows, reads } = counted(table);
  const { pages } = pagesOver(rows, LONG_ROWS);
  const windows = Array.from(
    { length: Math.ceil(LONG_ROWS / span) },
    (_, w) => [w * span, Math.min((w + 1) * span, LONG_ROWS)],
  );
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    for (let first = 0; first < LONG_ROWS; first += SCREEN) {
      const screen = await pages.rows(first, SCREEN);
      expect(screen[0]).toEqual(unpagedRow(first));
    }
    expect(reads).toEqual(windows);
    // Each column chunk is one page, which hyparquet decodes whole for any
    // window, but each string is decoded once.
    expect(decode).toHaveBeenCalledTimes(UNPAGED_STRINGS * LONG_ROWS);
  } finally {
    decode.mockRestore();
  }
  // Back up the rows, every block comes from the cache.
  for (let first = LONG_ROWS - SCREEN; first >= 0; first -= SCREEN) {
    await pages.rows(first, SCREEN);
  }
  expect(reads).toEqual(windows);
});

test('the cache holds blocks at the bytes they take as text, within its budget', async () => {
  const want = salesRows();
  const roomy = { ...TINY, cacheBytes: TUNING.cacheBytes };
  const whole = pagesOver(await sales(), want.length, roomy).pages;
  await whole.rows(0, want.length);
  expect(whole.held).toBe(asText(want));

  const { pages, index } = pagesOver(await sales(), want.length, TINY);
  for (let block = 0; block < index.blocks; block++) {
    await pages.records(block);
    expect(pages.held).toBeGreaterThan(0);
    expect(pages.held).toBeLessThanOrEqual(TINY.cacheBytes);
  }
});

test('a scan that keeps nothing decodes every window once, and leaves the cache as it is', async () => {
  const { rows, reads } = counted(await sales());
  const want = salesRows();
  const { pages, index } = pagesOver(rows, want.length, TINY);
  const scanned: string[][] = [];
  for (let block = 0; block < index.blocks; block++) {
    scanned.push(...(await pages.records(block, false)));
  }
  expect(scanned).toEqual(want);
  expect(reads).toHaveLength(Math.ceil(index.blocks / MAX_WINDOW_BLOCKS));
  expect(pages.held).toBe(0);
});

test('held to Parquet, the sales fixture reads as sales-q3.csv does, complete at open with its exact rows', async () => {
  const source = bytesSource(SALES);
  const reading = await openReading({
    name: SALES_NAME,
    source,
    spec: { kind: 'parquet', columns: [] },
    header: 'first',
    tuning: TINY,
  });
  expect(english(reading.label)).toBe('Parquet · snappy · 5 row groups');
  expect(reading.behind).toEqual({ t: 'file', stored: source });
  const columns = SALES_COLUMNS.map((name) => ({ name, key: `/${name}` }));
  expect(reading.columns()).toEqual(columns);
  expect(reading.spec()).toEqual({ kind: 'parquet', columns });

  const { index } = reading;
  expect([index.complete, index.readable(), index.rows()]).toEqual([
    true,
    ROWS,
    ROWS,
  ]);
  expect(index.indexed()).toEqual({ done: source.size, total: source.size });
  let told = 0;
  await reading.pass(new AbortController().signal, () => told++);
  expect(told).toBe(1);
  expect(await reading.pages.rows(0, ROWS)).toEqual(salesRows());
  expect(await reading.runs(index.blockOf(ROWS - 1))).toEqual([
    { row: 0, part: 0 },
  ]);
});

test('held to Parquet, several files joined as bytes are refused by name', async () => {
  // Parts with saved extents are read as a log was made, undetected.
  const part = {
    ref: { name: SALES_NAME, path: SALES_PATH },
    extent: { bytes: SALES.length, skip: 0, unterminated: false },
  };
  const source = await multiFiles([localFiles()]).open({
    name: 'sales',
    parts: [part, part],
    header: 'none',
  });
  try {
    await expect(
      openReading({
        name: 'sales',
        source,
        spec: { kind: 'parquet', columns: [] },
        header: 'first',
        tuning: TINY,
      }),
    ).rejects.toMatchObject({
      said: {
        t: 'parquet-unsupported',
        name: 'sales',
        feature: 'several-files',
      },
    });
  } finally {
    await source.close();
  }
});

test('held to Parquet with pinned columns, each key finds its column, a lost key reads empty and the rest follow named beside them', async () => {
  // A name pinned to another key takes its name from the file's column.
  const pinned = [
    { name: 'revenue', key: '/revenue' },
    { name: 'units', key: '/units' },
    { name: 'gone', key: '/gone' },
    { name: 'region', key: '/rep' },
  ];
  const reading = await openReading({
    name: SALES_NAME,
    source: bytesSource(SALES),
    spec: { kind: 'parquet', columns: pinned },
    header: 'first',
    tuning: TINY,
  });
  const columns = [
    ...pinned,
    { name: 'date', key: '/date' },
    { name: 'region_2', key: '/region' },
    { name: 'channel', key: '/channel' },
  ];
  expect(reading.columns()).toEqual(columns);
  expect(reading.spec()).toEqual({ kind: 'parquet', columns });
  // The file's columns each laid-out column reads, and none for gone.
  const read = ['revenue', 'units', 'gone', 'rep', 'date', 'region', 'channel'];
  const want = salesRows().map((row) => under(read, row));
  expect(await reading.pages.rows(0, ROWS)).toEqual(want);
});

/** The row a logged edit is made in, and what it writes. */
const EDITED_ROW = 3000;
const EDITED = 'edited';

/** A save's limit on carried bytes, which a pointed-at source never nears. */
const ROOMY = 1 << 20;

/** A .uno holding `source`, whose log is `sheet`'s edits to it. */
function workspace(source: Held, sheet: Sheet): Blob {
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [source],
    active: source.id,
    log: sheet.edits().map((edit) => ({ source: source.id, edit })),
    extra: new Map(),
    at: '',
  });
  expect(readContainer('q3.uno', uno).manifest.format).toBe(READ_VERSION);
  return new Blob([new Uint8Array(uno)]);
}

/** The sales fixture, said to be read as Parquet with `columns` pinned. */
function salesSource(sheet: Sheet, columns?: SavedColumn[]): Held {
  return {
    id: 'sales',
    name: SALES_NAME,
    path: SALES_PATH,
    bytes: SALES.length,
    kind: 'parquet',
    columns,
    rows: sheet.rows(),
    cols: sheet.cols(),
    state: { active: { row: 0, col: 0 } },
  };
}

/** withEngine runs `use` with an engine under TINY tuning. */
async function withEngine(use: (engine: Engine) => Promise<void>) {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    await use(engine);
  } finally {
    done();
  }
}

test('a workspace that says a source was read as Parquet opens it so, every row read and complete at open', () =>
  withEngine(async (engine) => {
    const sheet = new Sheet(SALES_NAME, [], []);
    const blob = workspace(salesSource(sheet), sheet);
    const src = await openOne(engine, { name: 'q3.uno', blob });
    expect(saidIn(src.opened.label)).toBe('Parquet · snappy · 5 row groups');
    expect(src.opened.progress).toMatchObject({
      done: SALES.length,
      total: SALES.length,
      readable: ROWS,
      rows: ROWS,
      complete: true,
    });
    expect(src.opened.columns.map((c) => c.header)).toEqual(SALES_COLUMNS);
    expect(await everyRow(src)).toEqual(salesRows());
  }));

test('a schema reordered since the save keeps each column, and each logged edit, on its key', () =>
  withEngine(async (engine) => {
    // Saved when the file held revenue and units first, date pinned by its
    // name alone.
    const order = ['revenue', 'units', 'date', 'region', 'rep', 'channel'];
    const columns = order.map((name): SavedColumn =>
      name === 'date' ? { name } : { name, key: `/${name}` },
    );
    const want = salesRows().map((row) => under(order, row));
    const sheet = new Sheet(SALES_NAME, order, want);
    const col = order.indexOf('units');
    sheet.set(EDITED_ROW, col, EDITED);

    const blob = workspace(salesSource(sheet, columns), sheet);
    const src = await openOne(engine, { name: 'q3.uno', blob });
    expect(src.opened.columns.map((c) => c.header)).toEqual(order);
    want[EDITED_ROW]![col] = EDITED;
    expect(await everyRow(src)).toEqual(want);
  }));

test('several files joined as bytes that say they were read as Parquet are refused by name', () =>
  withEngine(async (engine) => {
    const sheet = new Sheet('sales', [], []);
    const part = {
      name: SALES_NAME,
      path: SALES_PATH,
      bytes: SALES.length,
      skip: 0,
      unterminated: false,
    };
    const source: Held = {
      id: 'sales',
      name: 'sales',
      parts: [part, part],
      header: 'first',
      kind: 'parquet',
      rows: 0,
      cols: 0,
      state: { active: { row: 0, col: 0 } },
    };
    const src = await openOne(engine, {
      name: 'q3.uno',
      blob: workspace(source, sheet),
    });
    // A refusal from a .uno is said about its source, which this one names.
    expect(saidIn(src.opened.link?.missing)).toBe(
      'q3.uno: sales: sales: reading several Parquet files as one is not supported yet',
    );
  }));

test('a source read as Parquet saves its kind and pinned columns, and its edit reopens on its cell', async () => {
  const sheet = new Sheet(SALES_NAME, [], []);
  const blob = workspace(salesSource(sheet), sheet);
  const col = SALES_COLUMNS.indexOf('units');
  let saved: Uint8Array = new Uint8Array();
  await withEngine(async (engine) => {
    const src = await openOne(engine, { name: 'q3.uno', blob });
    engine.mode(true);
    await src.edit({ op: Op.Set, row: EDITED_ROW, col, now: EDITED });
    saved = await engine.save({ source: src.id, cells: [], at: '' }, ROOMY);
  });

  const [source] = readContainer('q3.uno', saved).sources;
  expect(source?.kind).toBe('parquet');
  // Each column is the top-level field of its name, so no key is written.
  expect(source?.columns).toEqual(SALES_COLUMNS.map((name) => ({ name })));
  const want = salesRows();
  want[EDITED_ROW]![col] = EDITED;
  await withEngine(async (engine) => {
    const blob = new Blob([new Uint8Array(saved)]);
    const src = await openOne(engine, { name: 'q3.uno', blob });
    expect(saidIn(src.opened.label)).toBe('Parquet · snappy · 5 row groups');
    expect(await everyRow(src)).toEqual(want);
  });
});
