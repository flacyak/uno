/**
 * @fileoverview A Parquet table reads rows as the text their writer meant:
 * the sales fixture as sales-q3.csv reads.
 */

import { expect, test } from 'vite-plus/test';

import { SALES, opened, salesRows } from './tables.ts';

const NAME = 'sales-q3.snappy.parquet';

test('the sales fixture reads the same cells as sales-q3.csv', async () => {
  const table = await opened(NAME, SALES);
  expect(await table.read(0, table.rows)).toEqual(salesRows());
});
