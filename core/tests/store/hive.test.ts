/**
 * @fileoverview partitionOf reads the key=value folders of a path under a
 * dataset's root, decoding escapes the way Hive and pyarrow write them, and
 * byPartPath orders those paths with whole numbers as numbers.
 */

import { expect, test } from 'vite-plus/test';

import { HIVE_NULL, byPartPath, partitionOf } from '@store/hive';

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

/** sorted is paths in the order byPartPath gives them. */
function sorted(paths: readonly string[]): string[] {
  return [...paths].sort(byPartPath);
}

test('month=9 comes before month=10, inside the year they are under', () => {
  const paths = [
    'year=2024/month=10/part-0.parquet',
    'year=2024/month=9/part-0.parquet',
    'year=2023/month=12/part-0.parquet',
  ];

  expect(sorted(paths)).toEqual([
    'year=2023/month=12/part-0.parquet',
    'year=2024/month=9/part-0.parquet',
    'year=2024/month=10/part-0.parquet',
  ]);
});

test('leading zeros order as the number they write, then as written', () => {
  const months = ['m=10/f', 'm=9/f', 'm=09/f', 'm=1/f', 'm=0/f', 'm=00/f'];

  expect(sorted(months)).toEqual([
    'm=0/f',
    'm=00/f',
    'm=1/f',
    'm=09/f',
    'm=9/f',
    'm=10/f',
  ]);
});

test('a whole number past what a double holds still orders exactly', () => {
  const ids = ['id=9007199254740993/f', 'id=9007199254740992/f'];

  expect(sorted(ids)).toEqual([
    'id=9007199254740992/f',
    'id=9007199254740993/f',
  ]);
});

test('a whole number comes before any other value of its key', () => {
  const paths = ['k=b/f', 'k=10/f', `k=${HIVE_NULL}/f`, 'k=2/f', 'k=-1/f'];

  expect(sorted(paths)).toEqual([
    'k=2/f',
    'k=10/f',
    'k=-1/f',
    `k=${HIVE_NULL}/f`,
    'k=b/f',
  ]);
});

// UTF-16 order would put U+20000, a surrogate pair, before U+FFFD.
test('other values order by code point, unicode included', () => {
  const cities = [
    'c=Århus/f',
    'c=Zürich/f',
    'c=Zagreb/f',
    'c=\u{20000}/f',
    'c=\uFFFD/f',
  ];

  expect(sorted(cities)).toEqual([
    'c=Zagreb/f',
    'c=Zürich/f',
    'c=Århus/f',
    'c=\uFFFD/f',
    'c=\u{20000}/f',
  ]);
});

test('files in one folder order by name as written', () => {
  const files = [
    'k=1/part-10.parquet',
    'k=1/part-9.parquet',
    'k=1/part-0.parquet',
  ];

  expect(sorted(files)).toEqual([
    'k=1/part-0.parquet',
    'k=1/part-10.parquet',
    'k=1/part-9.parquet',
  ]);
});
