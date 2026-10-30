/**
 * @fileoverview passedOver keeps a dataset's data files and passes over what
 * Spark and Hadoop leave beside them, and tableFormatOf finds the log of a
 * Delta Lake, Iceberg or Hudi table.
 */

import { expect, test } from 'vite-plus/test';

import { passedOver, tableFormatOf } from '@store/leftovers';

/** A size for a file that holds something, so only its name is judged. */
const SOME_BYTES = 1_024;

test('a data file is kept, under key=value folders or none', () => {
  expect(passedOver('part-0.parquet', SOME_BYTES)).toBe(false);
  expect(passedOver('year=2024/month=9/part-0.csv', SOME_BYTES)).toBe(false);
});

test("a job's markers and bookkeeping are passed over", () => {
  const leftovers = [
    '_SUCCESS',
    'year=2024/_committed_1',
    'year=2024/_started_1',
    '_temporary/0/_temporary/attempt_0/part-0.parquet',
    '_spark_metadata/0',
    '_metadata',
    '_common_metadata',
  ];

  for (const path of leftovers) {
    expect(passedOver(path, SOME_BYTES), path).toBe(true);
  }
});

test('a hidden file or folder is passed over, a checksum among them', () => {
  expect(passedOver('year=2024/.part-0.parquet.crc', SOME_BYTES)).toBe(true);
  expect(passedOver('.spark-staging-1/part-0.parquet', SOME_BYTES)).toBe(true);
  expect(passedOver('.year=2024/part-0.parquet', SOME_BYTES)).toBe(true);
});

test('a key=value folder starting with _ is kept', () => {
  expect(passedOver('_year=2024/part-0.parquet', SOME_BYTES)).toBe(false);
});

test('a file still being copied in is passed over', () => {
  const copying = 'year=2024/part-0.parquet._COPYING_';

  expect(passedOver(copying, SOME_BYTES)).toBe(true);
});

test('folder markers and empty files are passed over', () => {
  expect(passedOver('year=2024_$folder$', SOME_BYTES)).toBe(true);
  expect(passedOver('year=2024/', SOME_BYTES)).toBe(true);
  expect(passedOver('year=2024/part-0.parquet', 0)).toBe(true);
});

test('a Delta Lake table is found by its log, at the root or below it', () => {
  const log = '_delta_log/00000000000000000000.json';

  expect(tableFormatOf(log)).toBe('Delta Lake');
  expect(tableFormatOf(`sales/${log}`)).toBe('Delta Lake');
  expect(tableFormatOf('_delta_log/')).toBe('Delta Lake');
});

test('an Iceberg table is found by a metadata file in its metadata folder', () => {
  expect(tableFormatOf('metadata/v1.metadata.json')).toBe('Iceberg');
  expect(tableFormatOf('t/metadata/00001-a.gz.metadata.json')).toBe('Iceberg');
  expect(tableFormatOf('metadata/snap-1-a.avro')).toBeUndefined();
  expect(tableFormatOf('reports/v1.metadata.json')).toBeUndefined();
});

test('a Hudi table is found by its timeline', () => {
  expect(tableFormatOf('.hoodie/hoodie.properties')).toBe('Hudi');
});

test('a data file, or a file named like a log folder, is no table', () => {
  expect(tableFormatOf('year=2024/part-0.parquet')).toBeUndefined();
  expect(tableFormatOf('year=2024/_delta_log')).toBeUndefined();
});

// Why a table is asked for first: passed over, its log would leave its files
// read as data, deleted rows and all.
test('the logs of Delta Lake and Hudi would be passed over', () => {
  const logs = ['_delta_log/0.json', '.hoodie/hoodie.properties'];

  for (const log of logs) expect(passedOver(log, SOME_BYTES), log).toBe(true);
});
