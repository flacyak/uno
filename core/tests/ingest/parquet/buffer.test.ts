/**
 * @fileoverview asyncBufferOf hands hyparquet the exact bytes of a
 * ByteSource, one read per slice, and hyparquet reads a file through it.
 */

import { parquetReadObjects } from 'hyparquet/src/index.js';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { expect, test } from 'vite-plus/test';

import {
  CHUNK_CACHE_BYTES,
  asyncBufferOf,
  chunkCache,
} from '@ingest/parquet/buffer';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';

/** How many bytes the file holds. */
const SIZE = 1_000;

/** The file's bytes, each its own offset modulo 256. */
const BYTES = Uint8Array.from({ length: SIZE }, (_, i) => i % 256);

/** A source over BYTES, with each read as [offset, length] in `reads`. */
function logged(): {
  source: ByteSource;
  reads: Array<[offset: number, length: number]>;
} {
  const inner = bytesSource(BYTES);
  const reads: Array<[offset: number, length: number]> = [];
  return {
    reads,
    source: {
      size: inner.size,
      read(offset, length) {
        reads.push([offset, length]);
        return inner.read(offset, length);
      },
      close: () => inner.close(),
    },
  };
}

test('a slice is the exact bytes asked for, from one read of them', async () => {
  const { source, reads } = logged();
  const file = asyncBufferOf(source, chunkCache(0));
  expect(file.byteLength).toBe(SIZE);
  expect(new Uint8Array(await file.slice(100, 300))).toEqual(
    BYTES.slice(100, 300),
  );
  expect(reads).toEqual([[100, 200]]);
});

test('a slice takes its ends as ArrayBuffer.slice takes them', async () => {
  const { source, reads } = logged();
  const file = asyncBufferOf(source, chunkCache(0));
  const ends: Array<[start: number, end?: number]> = [
    [900],
    [-8],
    [-20, -10],
    [990, 2_000],
    [-2_000, 4],
    [50, 40],
  ];
  for (const [start, end] of ends) {
    expect(new Uint8Array(await file.slice(start, end)), `${start}`).toEqual(
      new Uint8Array(BYTES.buffer.slice(start, end)),
    );
  }
  // The empty range asks for nothing.
  expect(reads.every(([, length]) => length > 0)).toBe(true);
});

test('hyparquet reads a file through it', async () => {
  const written = parquetWriteBuffer({
    columnData: [
      { name: 'id', data: [1, 2, 3], type: 'INT32' },
      { name: 'city', data: ['Lisbon', 'Porto', 'Faro'], type: 'STRING' },
    ],
  });
  const source = bytesSource(new Uint8Array(written));
  const file = asyncBufferOf(source, chunkCache(CHUNK_CACHE_BYTES));
  expect(await parquetReadObjects({ file })).toEqual([
    { id: 1, city: 'Lisbon' },
    { id: 2, city: 'Porto' },
    { id: 3, city: 'Faro' },
  ]);
});
