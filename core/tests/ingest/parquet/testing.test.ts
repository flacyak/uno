/**
 * @fileoverview Each file vendored from apache/parquet-testing that uno reads
 * reads as the text beside it: what its footer says, its columns, and every
 * row. An upgrade of hyparquet that reads any value differently fails here.
 *
 * `vp test -u` writes the text again after a change meant to move it.
 */

import { expect, test } from 'vite-plus/test';

import type { Table } from '@ingest/parquet/table';

import { opened, testdata } from './tables.ts';

/** The vendored files uno reads, under tests/testdata/parquet. */
const READ: readonly string[] = [
  'alltypes_dictionary.parquet',
  'alltypes_plain.parquet',
  'alltypes_plain.snappy.parquet',
  'binary.parquet',
  'byte_array_decimal.parquet',
  'byte_stream_split.zstd.parquet',
  'concatenated_gzip_members.parquet',
  'data_index_bloom_encoding_stats.parquet',
  'datapage_v2.snappy.parquet',
  'fixed_length_decimal.parquet',
  'fixed_length_decimal_legacy.parquet',
  'float16_nonzeros_and_nans.parquet',
  'int32_decimal.parquet',
  'int32_with_null_pages.parquet',
  'int64_decimal.parquet',
  'int96_from_spark.parquet',
  'map_no_value.parquet',
  'nested_lists.snappy.parquet',
  'nested_maps.snappy.parquet',
  'nonnullable.impala.parquet',
  'null_list.parquet',
  'nulls.snappy.parquet',
  'repeated_no_annotation.parquet',
  'single_nan.parquet',
  'unknown-logical-type.parquet',
];

/**
 * A table and its rows as text: what its footer says, then each column as
 * its name and key, a blank line, and each row, one JSON value to a line.
 */
function goldenOf(table: Table, rows: readonly string[][]): string {
  const { rows: count, groups, codecs } = table;
  const footer = { rows: count, groups, codecs, paged: table.paged(0, count) };
  const lines = [
    JSON.stringify(footer),
    ...table.columns.map(({ name, key }) => JSON.stringify([name, key])),
    '',
    ...rows.map((row) => JSON.stringify(row)),
  ];
  return `${lines.join('\n')}\n`;
}

test.each(READ)('%s reads as the text beside it', async (path) => {
  const table = await opened(path, testdata(`parquet/${path}`));
  const rows = await table.read(0, table.rows);
  await expect(goldenOf(table, rows)).toMatchFileSnapshot(
    `../../testdata/parquet/${path}.txt`,
  );
});
