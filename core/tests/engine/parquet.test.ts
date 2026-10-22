/**
 * @fileoverview A Parquet file read by the engine: its blocks are planned
 * from its row count, complete from the start.
 */

import { expect, test } from 'vite-plus/test';

import { PlannedIndex } from '@engine/table';

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
