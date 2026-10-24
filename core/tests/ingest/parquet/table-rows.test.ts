/**
 * @fileoverview A Parquet table reads rows as the text their writer meant:
 * the sales fixture as sales-q3.csv reads, any range as a whole read has
 * it, and one column alone with every other cell empty. A page that does
 * not decode is refused as parquet-broken, and a failed read is passed on
 * as it failed.
 */

import { parquetMetadata } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { chunkCache } from '@ingest/parquet/buffer';
import { openTable } from '@ingest/parquet/table';
import type { Table } from '@ingest/parquet/table';
import { Refusal } from '@said';
import type { Said } from '@said';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { random } from '@core-tests/random';
import { COLS, REGION, ROWS } from '@core-tests/testdata/sales-q3';

import { SALES_GROUP_ROWS } from '../../../scripts/fixtures.ts';
import {
  SALES,
  logged,
  opened,
  salesRows,
  testdata,
  withoutPageIndexes,
} from './tables.ts';

const NAME = 'sales-q3.snappy.parquet';

/** How many random ranges are read, and the seed that picks them. */
const RANGES = 40;
const SEED = 44;

/** The bytes of a page header overwritten to damage it. */
const DAMAGE_BYTES = 16;

/** Some ranges of `rows` rows: fixed ones, and RANGES picked at random. */
function rangesOf(
  rows: number,
  fixed: Array<[number, number]>,
): Array<[number, number]> {
  const next = random(SEED);
  const ranges = [...fixed];
  for (let i = 0; i < RANGES; i++) {
    const start = Math.floor(next() * rows);
    ranges.push([start, start + Math.floor(next() * (rows - start + 1))]);
  }
  return ranges;
}

/** Each range of `table`, read as it is, and as a whole read has it. */
async function expectRanges(
  table: Table,
  ranges: ReadonlyArray<[number, number]>,
): Promise<void> {
  const whole = await table.read(0, table.rows);
  for (const [start, end] of ranges) {
    expect(await table.read(start, end), `${start}, ${end}`).toEqual(
      whole.slice(start, end),
    );
  }
}

/** The bytes asked for by the reads logged after the first `from`. */
function bytesAsked(
  reads: ReadonlyArray<[offset: number, length: number]>,
  from: number,
): number {
  return reads.slice(from).reduce((sum, [, length]) => sum + length, 0);
}

test('the sales fixture reads the same cells as sales-q3.csv', async () => {
  const table = await opened(NAME, SALES);
  expect(await table.read(0, table.rows)).toEqual(salesRows());
});

test('ranges inside and across row groups read as a whole read has them', async () => {
  const group = SALES_GROUP_ROWS;
  await expectRanges(
    await opened(NAME, SALES),
    rangesOf(ROWS, [
      [0, 1],
      [group - 1, group + 1],
      [group, 2 * group],
      [group / 2, 3 * group + group / 2],
      [ROWS - 1, ROWS],
      [group, group],
    ]),
  );
});

test('a range of a row group with offset indexes reads only the pages that hold it', async () => {
  const name = 'int32_with_null_pages.parquet';
  const { source, reads } = logged(testdata(`parquet/${name}`));
  const table = await openTable(name, source, chunkCache(0));
  expect(table.paged(0, table.rows)).toBe(true);
  const opening = reads.length;
  await table.read(0, table.rows);
  const whole = bytesAsked(reads, opening);
  const before = reads.length;
  await table.read(table.rows / 2, table.rows / 2 + 1);
  expect(bytesAsked(reads, before)).toBeLessThan(whole / 2);
  await expectRanges(table, rangesOf(table.rows, [[0, table.rows]]));
});

test('a field of a struct reads as a column of its own, and empty where its struct is null', async () => {
  const name = 'nonnullable.impala.parquet';
  const impala = await opened(name, testdata(`parquet/${name}`));
  const [row] = await impala.read(0, 1);
  const cell = (key: string): string | undefined =>
    row?.[impala.columns.findIndex((column) => column.key === key)];
  expect(cell('/nested_Struct/a')).toBe('-1');
  expect(cell('/nested_Struct/c/D')).toBe('[[{"e":-1,"f":"nonnullable"}]]');

  const nulls = await opened(
    'nulls.parquet',
    testdata('parquet/nulls.snappy.parquet'),
  );
  expect(await nulls.read(0, nulls.rows)).toEqual(
    Array.from({ length: nulls.rows }, () => ['']),
  );
});

/** `rows` with every cell but those of column `only` emptied. */
function only(rows: readonly string[][], column: number): string[][] {
  return rows.map((row) => row.map((cell, i) => (i === column ? cell : '')));
}

test('a read of one column fills only that column, and reads only its chunks', async () => {
  const { source, reads } = logged(SALES);
  const table = await openTable(NAME, source, chunkCache(0));
  const opening = reads.length;
  const whole = await table.read(0, ROWS);
  const wholeAsked = bytesAsked(reads, opening);
  const before = reads.length;
  expect(await table.read(0, ROWS, REGION)).toEqual(only(whole, REGION));
  expect(bytesAsked(reads, before)).toBeLessThan(wholeAsked / 2);
});

test('a read of one field of a struct fills only that field', async () => {
  const table = await opened(
    'nonnullable.impala.parquet',
    testdata('parquet/nonnullable.impala.parquet'),
  );
  const whole = await table.read(0, table.rows);
  const field = table.columns.findIndex(
    ({ key }) => key === '/nested_Struct/c/D',
  );
  expect(await table.read(0, table.rows, field)).toEqual(only(whole, field));
  expect(only(whole, field)[0]![field]).not.toBe('');
});

test('a read of a column the table does not have is a range error', async () => {
  const table = await opened(NAME, SALES);
  await expect(table.read(0, 1, COLS)).rejects.toBeInstanceOf(RangeError);
});

test('a page that does not decode is refused as parquet-broken', async () => {
  const [group] = parquetMetadata(SALES.slice().buffer).row_groups;
  const chunk = group!.columns[0]!.meta_data!;
  const start = Number(chunk.dictionary_page_offset ?? chunk.data_page_offset);
  const damaged = SALES.slice();
  damaged.fill(0xff, start, start + DAMAGE_BYTES);
  const table = await opened(NAME, damaged);
  let said: Said | undefined;
  await table.read(0, 1).catch((err: unknown) => {
    if (!(err instanceof Refusal)) throw err;
    said = err.said;
  });
  expect(said).toEqual({ t: 'parquet-broken', name: NAME });
});

test('a failed read of a page is passed on as it failed', async () => {
  const failure = new Error('EIO: i/o error, read');
  const inner = bytesSource(SALES);
  let footerRead = false;
  const source: ByteSource = {
    size: inner.size,
    read: (offset, length) => {
      if (footerRead) return Promise.reject(failure);
      footerRead = true;
      return inner.read(offset, length);
    },
    close: () => inner.close(),
  };
  const table = await openTable(NAME, source, chunkCache(0));
  await expect(table.read(0, 1)).rejects.toBe(failure);
});

/** Every row of `table`, read `size` rows at a time. */
async function inWindows(table: Table, size: number): Promise<string[][]> {
  const rows: string[][] = [];
  for (let start = 0; start < table.rows; start += size) {
    rows.push(...(await table.read(start, start + size)));
  }
  return rows;
}

test('the windows of a row group with no page index read its chunks once, whatever the chunk cache holds', async () => {
  const name = 'int32_with_null_pages.parquet';
  const bytes = withoutPageIndexes(testdata(`parquet/${name}`));
  const { source, reads } = logged(bytes);
  const table = await openTable(name, source, chunkCache(0));
  expect(table.paged(0, table.rows)).toBe(false);
  const opening = reads.length;
  const window = table.rows / 10;
  const whole = await (await opened(name, bytes)).read(0, table.rows);
  expect(await inWindows(table, window)).toEqual(whole);
  expect(reads.slice(opening)).toHaveLength(1);
});
