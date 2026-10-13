/**
 * @fileoverview partitionOf reads the key=value folders of a path under a
 * dataset's root, decoding escapes the way Hive and pyarrow write them.
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

test('an escape decodes as UTF-8, in the key and in the value', () => {
  const read = partitionOf(
    'ts=2024-01-01 00%3A00%3A00/a%3Db=caf%C3%A9/f.parquet',
  );

  expect(read).toEqual({
    keys: ['ts', 'a=b'],
    values: ['2024-01-01 00:00:00', 'café'],
  });
});

test('a malformed escape stays as written, and the rest still decode', () => {
  const values = (folder: string): readonly string[] =>
    partitionOf(`${folder}/f.parquet`).values;

  expect(values('k=%ZZ')).toEqual(['%ZZ']);
  expect(values('k=50%')).toEqual(['50%']);
  // A byte that starts no code point, and a lead byte with too few after it.
  expect(values('k=%FF%41')).toEqual(['%FFA']);
  expect(values('k=%E2%82')).toEqual(['%E2%82']);
  expect(values('k=%E2%82x%E2%82%AC')).toEqual(['%E2%82x€']);
});

test('a plus sign is kept, and unicode written as is reads as is', () => {
  const read = partitionOf('q=a+b/city=Zürich/name=東京/f.parquet');

  expect(read.values).toEqual(['a+b', 'Zürich', '東京']);
});

test("Hive's null partition reads as empty, as does an empty value", () => {
  const read = partitionOf(`year=${HIVE_NULL}/month=/f.parquet`);

  expect(read).toEqual({ keys: ['year', 'month'], values: ['', ''] });
});
