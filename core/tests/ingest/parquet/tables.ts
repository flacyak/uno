/**
 * @fileoverview The Parquet files the Parquet tests open, the rows the sales
 * fixture holds, files written for a test, and sources over them that log
 * each read.
 */

import { readFileSync } from 'node:fs';

import { parquetMetadata } from 'hyparquet/src/index.js';
import {
  ByteWriter,
  ParquetWriter,
  parquetWriteBuffer,
} from 'hyparquet-writer';

import { readAll } from '@ingest/csv';
import {
  PARQUET_FOOTER_LENGTH_BYTES,
  PARQUET_MAGIC_BYTES,
} from '@ingest/detect';
import { CHUNK_CACHE_BYTES, chunkCache } from '@ingest/parquet/buffer';
import { openTable } from '@ingest/parquet/table';
import type { Table } from '@ingest/parquet/table';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { COLS, FIXTURE } from '@core-tests/testdata/sales-q3';

const TESTDATA = new URL('../../testdata/', import.meta.url);

/** The bytes of a file under tests/testdata. */
export function testdata(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, TESTDATA)));
}

/** sales-q3.csv as Parquet, as scripts/fixtures.ts writes it. */
export const SALES = testdata('sales-q3.snappy.parquet');

/** sales-q3.csv's rows, with the cells a short row leaves out empty. */
export function salesRows(): string[][] {
  const [, ...rows] = readAll(readFileSync(FIXTURE, 'utf8'), ',');
  return rows.map((row) =>
    Array.from({ length: COLS }, (_, i) => row[i] ?? ''),
  );
}

/** A source over `bytes`, with each read as [offset, length] in `reads`. */
export function logged(bytes: Uint8Array): {
  source: ByteSource;
  reads: Array<[offset: number, length: number]>;
} {
  const inner = bytesSource(bytes);
  const reads: Array<[offset: number, length: number]> = [];
  const read = (offset: number, length: number): Promise<Uint8Array> => {
    reads.push([offset, length]);
    return inner.read(offset, length);
  };
  const close = (): Promise<void> => inner.close();
  return { reads, source: { size: inner.size, read, close } };
}

/** `bytes` opened as a table called `name`. */
export function opened(name: string, bytes: Uint8Array): Promise<Table> {
  return openTable(name, bytesSource(bytes), chunkCache(CHUNK_CACHE_BYTES));
}

/**
 * A row of `unpaged(rows)`: its number, and a name made from it, as textOf
 * writes them.
 */
export function unpagedRow(i: number): string[] {
  return [String(i), `n${i}`];
}

/** How many strings each row of `unpaged(rows)` stores. */
export const UNPAGED_STRINGS = 1;

/**
 * A file of `rows` rows in one row group with no page index, each column
 * chunk one page: a number, and a string that differs on every row.
 */
export function unpaged(rows: number): Uint8Array {
  const numbers = Array.from({ length: rows }, (_, i) => i);
  const buffer = parquetWriteBuffer({
    schema: [
      { name: 'root', num_children: 2 },
      { name: 'id', type: 'INT32', repetition_type: 'REQUIRED' },
      {
        name: 'name',
        type: 'BYTE_ARRAY',
        converted_type: 'UTF8',
        repetition_type: 'REQUIRED',
      },
    ],
    columnData: [
      { name: 'id', data: numbers },
      { name: 'name', data: numbers.map((i) => `n${i}`) },
    ],
    rowGroupSize: rows,
  });
  return new Uint8Array(buffer);
}

/**
 * `bytes` with the page indexes left out of its footer, so a read finds
 * no pages but by walking each column chunk from its start.
 */
export function withoutPageIndexes(bytes: Uint8Array): Uint8Array {
  const metadata = parquetMetadata(bytes.slice().buffer);
  const footer = PARQUET_FOOTER_LENGTH_BYTES + PARQUET_MAGIC_BYTES;
  const footerStart = bytes.length - footer - metadata.metadata_length;
  const writer = new ByteWriter();
  // The writer starts the file with its magic, and the rest follows as it was.
  const parquet = new ParquetWriter({ writer, schema: metadata.schema });
  writer.appendBytes(bytes.subarray(PARQUET_MAGIC_BYTES, footerStart));
  parquet.num_rows = metadata.num_rows;
  parquet.row_groups = metadata.row_groups.map((group) => ({
    ...group,
    columns: group.columns.map((chunk) => {
      const plain = { ...chunk };
      delete plain.offset_index_offset;
      delete plain.offset_index_length;
      delete plain.column_index_offset;
      delete plain.column_index_length;
      return plain;
    }),
  }));
  parquet.finish();
  return new Uint8Array(writer.getBuffer());
}
