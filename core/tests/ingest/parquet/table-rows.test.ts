/**
 * @fileoverview A Parquet table reads rows as the text their writer meant:
 * the sales fixture as sales-q3.csv reads, and any range as a whole read
 * has it.
 */

import { expect, test } from 'vite-plus/test';

import { chunkCache } from '@ingest/parquet/buffer';
import { openTable } from '@ingest/parquet/table';
import type { Table } from '@ingest/parquet/table';
import { random } from '@core-tests/random';
import { ROWS } from '@core-tests/testdata/sales-q3';

import { SALES_GROUP_ROWS } from '../../../scripts/fixtures.ts';
import { SALES, logged, opened, salesRows, testdata } from './tables.ts';

const NAME = 'sales-q3.snappy.parquet';

/** How many random ranges are read, and the seed that picks them. */
const RANGES = 40;
const SEED = 44;

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
