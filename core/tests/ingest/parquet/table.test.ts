/**
 * @fileoverview A Parquet table reads its footer from one read of the file's
 * tail, and says what the file holds.
 */

import { expect, test } from 'vite-plus/test';

import { CHUNK_CACHE_BYTES, chunkCache } from '@ingest/parquet/buffer';
import { openTable } from '@ingest/parquet/table';
import type { ByteSource } from '@store';
import { ROWS } from '@core-tests/testdata/sales-q3';

import { SALES_GROUP_ROWS } from '../../../scripts/fixtures.ts';
import { SALES, logged } from './tables.ts';

test('a footer in the tail says the columns, rows and groups from one read', async () => {
  const { source, reads } = logged(SALES);
  const table = await openTable(
    'sales-q3.snappy.parquet',
    source,
    chunkCache(CHUNK_CACHE_BYTES),
  );
  expect(table.columns).toEqual(
    ['date', 'region', 'rep', 'channel', 'units', 'revenue'].map((name) => ({
      name,
      key: `/${name}`,
    })),
  );
  expect(table.rows).toBe(ROWS);
  expect(table.groups).toBe(Math.ceil(ROWS / SALES_GROUP_ROWS));
  // The file is smaller than the tail, so the one read is all of it.
  expect(reads).toEqual([[0, SALES.length]]);
});

test('a failed read of the file is passed on as it failed', async () => {
  const failure = new Error('EIO: i/o error, read');
  const source: ByteSource = {
    size: SALES.length,
    read: () => Promise.reject(failure),
    close: () => Promise.resolve(),
  };
  await expect(
    openTable('sales-q3.snappy.parquet', source, chunkCache(0)),
  ).rejects.toBe(failure);
});
