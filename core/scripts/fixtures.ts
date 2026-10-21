/**
 * @fileoverview Writes the Parquet fixtures under tests/testdata from the CSV
 * fixtures there, with hyparquet-writer, the same bytes on every run.
 *
 *   node --experimental-transform-types --import ../paths.js scripts/fixtures.ts
 *
 * It reads the CSV with the core's own reader, whose classes Node runs only
 * with their types transformed rather than stripped.
 *
 * - sales-q3.snappy.parquet is sales-q3.csv with its columns typed: date a
 *   DATE, revenue a DECIMAL(9, 2), and the rest strings, units among them
 *   since its numbers carry thousands separators. A cell a short row leaves
 *   out is null. Its pages are snappy, in row groups of 1,000 rows.
 *
 * tests/ingest/parquet/fixtures.test.ts holds each file to what this writes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { SchemaElement } from 'hyparquet/src/index.js';
import { parquetWriteBuffer } from 'hyparquet-writer';

import { readAll } from '@ingest/csv';

/** The folder the fixtures are read from and written to. */
const TESTDATA = new URL('../tests/testdata/', import.meta.url);

/** The rows in each row group of sales-q3.snappy.parquet, but the last. */
export const SALES_GROUP_ROWS = 1_000;

/** The digits revenue keeps, and those after its point. */
const REVENUE_PRECISION = 9;
const REVENUE_SCALE = 2;

/** sales-q3.csv's columns, in its order. */
const [DATE, REGION, REP, CHANNEL, UNITS, REVENUE] = [0, 1, 2, 3, 4, 5];

/** sales-q3.csv as Parquet, its columns typed as the file's overview says. */
function salesQ3(): Uint8Array {
  const text = readFileSync(new URL('sales-q3.csv', TESTDATA), 'utf8');
  const rows = readAll(text, ',').slice(1);
  const cells = (column: number): string[] => rows.map((row) => row[column]!);
  const present = (column: number): Array<string | null> =>
    rows.map((row) => row[column] ?? null);
  const string = { type: 'BYTE_ARRAY', converted_type: 'UTF8' } as const;
  const columns: SchemaElement[] = [
    {
      name: 'date',
      type: 'INT32',
      converted_type: 'DATE',
      repetition_type: 'REQUIRED',
    },
    { name: 'region', ...string, repetition_type: 'REQUIRED' },
    { name: 'rep', ...string, repetition_type: 'REQUIRED' },
    { name: 'channel', ...string, repetition_type: 'REQUIRED' },
    { name: 'units', ...string, repetition_type: 'OPTIONAL' },
    {
      name: 'revenue',
      type: 'INT32',
      converted_type: 'DECIMAL',
      precision: REVENUE_PRECISION,
      scale: REVENUE_SCALE,
      repetition_type: 'OPTIONAL',
    },
  ];
  const buffer = parquetWriteBuffer({
    rowGroupSize: SALES_GROUP_ROWS,
    schema: [{ name: 'root', num_children: columns.length }, ...columns],
    columnData: [
      {
        name: 'date',
        data: cells(DATE).map((day) => new Date(`${day}T00:00:00Z`)),
      },
      { name: 'region', data: cells(REGION) },
      { name: 'rep', data: cells(REP) },
      { name: 'channel', data: cells(CHANNEL) },
      { name: 'units', data: present(UNITS) },
      {
        name: 'revenue',
        data: present(REVENUE).map((cell) =>
          cell === null ? null : Number(cell),
        ),
      },
    ],
  });
  return new Uint8Array(buffer);
}

/** fixtures is each fixture's bytes, by its path under tests/testdata. */
export function fixtures(): Map<string, Uint8Array> {
  return new Map([['sales-q3.snappy.parquet', salesQ3()]]);
}

if (import.meta.main) {
  for (const [path, bytes] of fixtures()) {
    writeFileSync(new URL(path, TESTDATA), bytes);
  }
}
