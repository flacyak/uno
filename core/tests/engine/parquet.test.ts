/**
 * @fileoverview A Parquet file read by the engine: its blocks are planned
 * from its row count, complete from the start. A block of a paged row group
 * reads alone, and one of an unpaged group with its window, once while the
 * rows are scrolled, and the cache holds them within its budget as text.
 */

import { expect, test } from 'vite-plus/test';

import { TUNING } from '@engine';
import {
  DECODE_WINDOW_BYTES,
  MAX_WINDOW_BLOCKS,
  PlannedIndex,
  TablePages,
} from '@engine/table';
import type { TableRows } from '@engine/table';
import type { Table } from '@ingest';
import { SALES, opened, salesRows } from '@core-tests/ingest/parquet/tables';
import { TINY } from './harness.ts';

/** A planned file's rows and stored bytes, and the rows in its blocks. */
const PLAN = { rows: 30, size: 4096, blockRows: 7 };
/** The block holding PLAN's last two rows. */
const LAST_BLOCK = 4;

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
 * A table whose rows are one cell, the row's number, which is paged or not
 * and takes `bytesPerRow` uncompressed.
 */
function planned(
  paged: boolean,
  bytesPerRow: number,
): { rows: TableRows; reads: Reads } {
  const reads: Reads = [];
  const rows: TableRows = {
    read: (start, end) => {
      reads.push([start, end]);
      const cells = Array.from({ length: end - start }, (_, i) => [
        String(start + i),
      ]);
      return Promise.resolve(cells);
    },
    paged: () => paged,
    bytesPerRow: () => bytesPerRow,
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
  return opened('sales-q3.snappy.parquet', SALES);
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

test('the sales fixture reads as sales-q3.csv does, every window once', async () => {
  const { rows, reads } = counted(await sales());
  const want = salesRows();
  const { pages, index } = pagesOver(rows, want.length, TINY);
  expect(await pages.rows(0, want.length)).toEqual(want);
  expect(reads).toHaveLength(Math.ceil(index.blocks / MAX_WINDOW_BLOCKS));
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

test('a block read to keep nothing leaves the cache as it is', async () => {
  const want = salesRows();
  const { pages } = pagesOver(await sales(), want.length, TINY);
  expect(await pages.records(1, false)).toEqual(
    want.slice(TINY.blockRows, 2 * TINY.blockRows),
  );
  expect(pages.held).toBe(0);
});
