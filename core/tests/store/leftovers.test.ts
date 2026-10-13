/**
 * @fileoverview passedOver keeps a dataset's data files and passes over what
 * Spark and Hadoop leave beside them.
 */

import { expect, test } from 'vite-plus/test';

import { passedOver } from '@store/leftovers';

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
