/**
 * @fileoverview partitionOf reads the key=value folders of a path under a
 * dataset's root.
 */

import { expect, test } from 'vite-plus/test';

import { HIVE_NULL, partitionOf } from '@store/hive';

test('each key=value folder is a key and its value, in path order', () => {
  expect(partitionOf('year=2024/month=09/part-0.parquet')).toEqual({
    keys: ['year', 'month'],
    values: ['2024', '09'],
  });
});

test('the file name is not read, even with an = in it', () => {
  expect(partitionOf('year=2024/day=1.parquet').keys).toEqual(['year']);
  expect(partitionOf('part-0.parquet')).toEqual({ keys: [], values: [] });
});

test('a folder with no =, two of them or no key names no key', () => {
  const read = partitionOf('exports/a=b=c/=7/year=2024/part-0.parquet');

  expect(read).toEqual({ keys: ['year'], values: ['2024'] });
});

test('a plus sign is kept, and unicode written as is reads as is', () => {
  const read = partitionOf('q=a+b/city=Zürich/name=東京/f.parquet');

  expect(read.values).toEqual(['a+b', 'Zürich', '東京']);
});

test("Hive's null partition reads as empty, as does an empty value", () => {
  const read = partitionOf(`year=${HIVE_NULL}/month=/f.parquet`);

  expect(read).toEqual({ keys: ['year', 'month'], values: ['', ''] });
});
