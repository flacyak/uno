/**
 * @fileoverview A Parquet table reads its footer from one read of the file's
 * tail, or two where the footer is longer, checks its magic at both ends,
 * and says what the file holds. A file that uses what uno does not read yet
 * is refused by name, and one whose footer is damaged as parquet-broken.
 */

import {
  ByteWriter,
  ParquetWriter,
  parquetWriteBuffer,
} from 'hyparquet-writer';
import { expect, test } from 'vite-plus/test';

import { PARQUET_MAGIC_BYTES } from '@ingest/detect';
import { CHUNK_CACHE_BYTES, chunkCache } from '@ingest/parquet/buffer';
import { PARQUET_TAIL_BYTES, openTable } from '@ingest/parquet/table';
import { Refusal } from '@said';
import type { ParquetFeature, Said } from '@said';
import type { ByteSource } from '@store';
import { ROWS } from '@core-tests/testdata/sales-q3';

import { SALES_GROUP_ROWS } from '../../../scripts/fixtures.ts';
import { SALES, logged, opened, testdata } from './tables.ts';

/** The columns of a file wider than its footer's tail. */
const WIDE_COLUMNS = 2_000;

/** The bytes that end a file after its footer: its length, then PAR1. */
const FOOTER_END_BYTES = 8;

/** Where the footer of a Parquet file's bytes starts. */
function footerStart(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const length = view.getUint32(bytes.length - FOOTER_END_BYTES, true);
  return bytes.length - FOOTER_END_BYTES - length;
}

/** What opening `bytes` refused, as the Said of its Refusal. */
async function refusalOf(
  name: string,
  bytes: Uint8Array,
): Promise<Said | undefined> {
  try {
    await opened(name, bytes);
  } catch (err) {
    if (err instanceof Refusal) return err.said;
    throw err;
  }
  return undefined;
}

/** Each vendored parquet-testing file that is refused, with what it uses. */
async function expectRefused(
  files: ReadonlyArray<[path: string, feature: ParquetFeature]>,
): Promise<void> {
  for (const [path, feature] of files) {
    expect(await refusalOf(path, testdata(`parquet/${path}`)), path).toEqual({
      t: 'parquet-unsupported',
      name: path,
      feature,
    });
  }
}

/** The bytes of an INTERVAL: months, days and milliseconds. */
const INTERVAL_BYTES = 12;

/** A file of one INT32 column, n, with `change` made to it before its footer. */
function written(change: (writer: ParquetWriter) => void): Uint8Array {
  const writer = new ByteWriter();
  const parquet = new ParquetWriter({
    writer,
    schema: [
      { name: 'root', num_children: 1 },
      { name: 'n', type: 'INT32', repetition_type: 'REQUIRED' },
    ],
  });
  parquet.write({ columnData: [{ name: 'n', data: [1] }] });
  change(parquet);
  parquet.finish();
  return new Uint8Array(writer.getBuffer());
}

test('a footer in the tail says the columns, rows, groups and codecs from one read', async () => {
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
  expect(table.codecs).toEqual(['snappy']);
  // The file is smaller than the tail, so the one read is all of it.
  expect(reads).toEqual([[0, SALES.length]]);
});

/** A file whose footer is longer than PARQUET_TAIL_BYTES. */
function wide(): Uint8Array {
  return new Uint8Array(
    parquetWriteBuffer({
      columnData: Array.from({ length: WIDE_COLUMNS }, (_, i) => ({
        name: `c${i}`,
        data: [i],
        type: 'INT32',
        nullable: false,
      })),
    }),
  );
}

test('a footer over 64 KB takes one more read, of the rest of it, and the head is read beside the tail', async () => {
  const bytes = wide();
  const start = footerStart(bytes);
  const tailStart = bytes.length - PARQUET_TAIL_BYTES;
  expect(bytes.length - start).toBeGreaterThan(PARQUET_TAIL_BYTES);
  const { source, reads } = logged(bytes);
  const table = await openTable('wide.parquet', source, chunkCache(0));
  expect(table.columns).toHaveLength(WIDE_COLUMNS);
  expect(reads).toEqual([
    [tailStart, PARQUET_TAIL_BYTES],
    [0, PARQUET_MAGIC_BYTES],
    [start, tailStart - start],
  ]);
});

test('a file longer than the tail with no magic at its head is refused as parquet-broken', async () => {
  const headless = wide();
  headless.fill(0, 0, PARQUET_MAGIC_BYTES);
  expect(await refusalOf('wide.parquet', headless)).toEqual({
    t: 'parquet-broken',
    name: 'wide.parquet',
  });
});

test('a truncated or damaged footer is refused as parquet-broken', async () => {
  const name = 'sales-q3.snappy.parquet';
  const start = footerStart(SALES);
  const zeroed = SALES.slice();
  zeroed.fill(0, start, SALES.length - FOOTER_END_BYTES);
  const headless = SALES.slice();
  headless[0] = 0;
  const longer = SALES.slice();
  new DataView(longer.buffer).setUint32(
    longer.length - FOOTER_END_BYTES,
    longer.length,
    true,
  );
  const damaged: Array<[string, Uint8Array]> = [
    ['cut short', SALES.subarray(0, SALES.length - 1)],
    ['cut inside its footer', SALES.subarray(0, start + 1)],
    ['too short to hold a footer', SALES.subarray(0, FOOTER_END_BYTES)],
    ['a footer longer than the file', longer],
    ['a footer of zeros', zeroed],
    ['no magic at its head', headless],
  ];
  for (const [what, bytes] of damaged) {
    expect(await refusalOf(name, bytes), what).toEqual({
      t: 'parquet-broken',
      name,
    });
  }
});

test('a file whose footer is encrypted is refused by name', async () => {
  await expectRefused([
    ['encrypt_columns_and_footer.parquet.encrypted', 'encryption'],
  ]);
});

test('pages in a codec uno does not read, and encrypted columns, are refused by name', async () => {
  await expectRefused([
    ['large_string_map.brotli.parquet', 'brotli'],
    ['lz4_raw_compressed.parquet', 'lz4'],
    ['hadoop_lz4_compressed.parquet', 'lz4'],
    ['encrypt_columns_plaintext_footer.parquet.encrypted', 'encryption'],
  ]);
});

test('columns kept in another file are refused by name', async () => {
  const elsewhere = written((parquet) => {
    parquet.row_groups[0]!.columns[0]!.file_path = 'other.parquet';
  });
  expect(await refusalOf('q3.parquet', elsewhere)).toEqual({
    t: 'parquet-unsupported',
    name: 'q3.parquet',
    feature: 'external-columns',
  });
  const here = written((parquet) => {
    parquet.row_groups[0]!.columns[0]!.file_path = '';
  });
  expect(await refusalOf('q3.parquet', here)).toBeUndefined();
});

test('a column of a type uno does not read yet is refused by name', async () => {
  await expectRefused([
    ['bson.parquet', 'bson'],
    ['shredded_variant/case-001.parquet', 'variant'],
  ]);
  const interval = new Uint8Array(
    parquetWriteBuffer({
      schema: [
        { name: 'root', num_children: 1 },
        {
          name: 'span',
          type: 'FIXED_LEN_BYTE_ARRAY',
          type_length: INTERVAL_BYTES,
          converted_type: 'INTERVAL',
          repetition_type: 'REQUIRED',
        },
      ],
      columnData: [{ name: 'span', data: [new Uint8Array(INTERVAL_BYTES)] }],
    }),
  );
  expect(await refusalOf('q3.parquet', interval)).toEqual({
    t: 'parquet-unsupported',
    name: 'q3.parquet',
    feature: 'interval',
  });
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
