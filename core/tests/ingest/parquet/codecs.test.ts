/**
 * @fileoverview A Parquet page compressed with gzip or zstd decompresses
 * through the core's own codecs, every member and frame of it, and a codec
 * uno does not read is refused by name.
 */

import { gzipSync, zstdCompressSync } from 'node:zlib';
import type { CompressionCodec } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { COMPRESSORS, codecOf } from '@ingest/parquet/codecs';
import { Refusal } from '@said';
import type { Said } from '@said';

const encoder = new TextEncoder();

/** Two pieces of a page, each compressed on its own. */
const PIECES = [encoder.encode('date,region\n'), encoder.encode('2026-07-01')];

/** The page the pieces make, as it was before it was compressed. */
const PAGE = encoder.encode('date,region\n2026-07-01');

/** What `run` threw, as the Said of a Refusal. */
function refused(run: () => unknown): Said | undefined {
  try {
    run();
  } catch (err) {
    if (err instanceof Refusal) return err.said;
    throw err;
  }
  return undefined;
}

test('a gzip page of several members decompresses whole', () => {
  const page = Buffer.concat(PIECES.map((piece) => gzipSync(piece)));
  expect(COMPRESSORS.GZIP?.(page, PAGE.length)).toEqual(PAGE);
});

test('a zstd page of several frames decompresses whole', () => {
  const page = Buffer.concat(PIECES.map((piece) => zstdCompressSync(piece)));
  expect(COMPRESSORS.ZSTD?.(page, PAGE.length)).toEqual(PAGE);
});

test('a codec uno reads is named as a label names it', () => {
  const read: Array<[CompressionCodec, string]> = [
    ['UNCOMPRESSED', 'uncompressed'],
    ['SNAPPY', 'snappy'],
    ['GZIP', 'gzip'],
    ['ZSTD', 'zstd'],
  ];
  for (const [codec, name] of read) {
    expect(codecOf('q3.parquet', codec)).toBe(name);
  }
});

test('a codec uno does not read is refused by name, and an unknown one as damage', () => {
  const name = 'q3.parquet';
  const refusals: Array<[CompressionCodec | undefined, Said]> = [
    ['BROTLI', { t: 'parquet-unsupported', name, feature: 'brotli' }],
    ['LZ4', { t: 'parquet-unsupported', name, feature: 'lz4' }],
    ['LZ4_RAW', { t: 'parquet-unsupported', name, feature: 'lz4' }],
    ['LZO', { t: 'parquet-unsupported', name, feature: 'lzo' }],
    [undefined, { t: 'parquet-broken', name }],
  ];
  for (const [codec, said] of refusals) {
    expect(
      refused(() => codecOf(name, codec)),
      codec,
    ).toEqual(said);
  }
});
