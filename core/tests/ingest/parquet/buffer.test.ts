/**
 * @fileoverview asyncBufferOf hands hyparquet the exact bytes of a
 * ByteSource, one read per slice, and hyparquet reads a file through it. Its
 * ChunkCache answers a range inside a held slice without a read, and holds no
 * more than its budget.
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

/** A budget nothing here fills. */
const ROOMY = 1 << 20;

test('a range inside a held slice is answered without a read', async () => {
  const { source, reads } = logged();
  const cache = chunkCache(ROOMY);
  const file = asyncBufferOf(source, cache);
  // A reader that writes over its copy leaves the held bytes as they were.
  new Uint8Array(await file.slice(0, 500)).fill(0);
  expect(new Uint8Array(await file.slice(100, 200))).toEqual(
    BYTES.slice(100, 200),
  );
  expect(new Uint8Array(await file.slice(0, 500))).toEqual(BYTES.slice(0, 500));
  expect(reads).toEqual([[0, 500]]);
  // A range that runs past every held slice is read.
  await file.slice(400, 600);
  expect(reads).toEqual([
    [0, 500],
    [400, 200],
  ]);
  expect(cache.held).toBe(700);
});

test('slices are held per file, and one range asked twice at once is read once', async () => {
  const a = logged();
  const b = logged();
  const cache = chunkCache(ROOMY);
  await Promise.all([
    asyncBufferOf(a.source, cache).slice(0, 100),
    asyncBufferOf(a.source, cache).slice(10, 20),
    asyncBufferOf(b.source, cache).slice(0, 100),
  ]);
  expect([a.reads, b.reads]).toEqual([[[0, 100]], [[0, 100]]]);
  expect(cache.held).toBe(200);
});

test('the slice used least recently goes once the budget is passed', async () => {
  const { source, reads } = logged();
  const cache = chunkCache(250);
  const file = asyncBufferOf(source, cache);
  await file.slice(0, 100);
  await file.slice(100, 200);
  await file.slice(0, 50);
  await file.slice(200, 300);
  expect(cache.held).toBe(200);
  await file.slice(0, 100);
  await file.slice(100, 200);
  expect(reads.map(([offset]) => offset)).toEqual([0, 100, 200, 100]);
  expect(cache.held).toBeLessThanOrEqual(250);
});

test('a slice larger than the budget is read, and neither held nor pushes one out', async () => {
  const { source, reads } = logged();
  const cache = chunkCache(100);
  const file = asyncBufferOf(source, cache);
  await file.slice(0, 50);
  await file.slice(0, 500);
  await file.slice(0, 500);
  await file.slice(10, 20);
  expect(reads.map(([, length]) => length)).toEqual([50, 500, 500]);
  expect(cache.held).toBe(50);
});

test('a failed read is not held, so the next slice of it reads again', async () => {
  const { source } = logged();
  let failures = 1;
  const flaky: ByteSource = {
    ...source,
    read: (offset, length) =>
      failures-- > 0
        ? Promise.reject(new Error('the connection dropped'))
        : source.read(offset, length),
  };
  const cache = chunkCache(ROOMY);
  const file = asyncBufferOf(flaky, cache);
  await expect(file.slice(0, 100)).rejects.toThrow('the connection dropped');
  expect(cache.held).toBe(0);
  expect(new Uint8Array(await file.slice(0, 100))).toEqual(BYTES.slice(0, 100));
});
