/**
 * @fileoverview The Parquet files the Parquet tests open, and sources over
 * them that log each read.
 */

import { readFileSync } from 'node:fs';

import { bytesSource } from '@store';
import type { ByteSource } from '@store';

const TESTDATA = new URL('../../testdata/', import.meta.url);

/** The bytes of a file under tests/testdata. */
export function testdata(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, TESTDATA)));
}

/** sales-q3.csv as Parquet, as scripts/fixtures.ts writes it. */
export const SALES = testdata('sales-q3.snappy.parquet');

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
