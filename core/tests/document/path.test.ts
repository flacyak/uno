/**
 * @fileoverview Tests for how a .uno stores and resolves source paths: relative
 * when the file is under the workspace's folder, absolute otherwise. Windows
 * and POSIX paths are both handled.
 */

import { expect, test } from 'vite-plus/test';

import {
  against,
  baseOf,
  dirOf,
  isAbsolute,
  onRoot,
  relativeTo,
  resolvedPath,
  samePath,
  storedPath,
  underRoot,
} from '@document';

test("a path under the workspace's folder is written down relative to it", () => {
  expect(storedPath('/home/cpa/q4/sales.csv', '/home/cpa/q4/books.uno')).toBe(
    'sales.csv',
  );
  expect(
    storedPath('/home/cpa/q4/exports/ads.csv', '/home/cpa/q4/books.uno'),
  ).toBe('exports/ads.csv');
});

// Paths outside the workspace folder are stored absolute.
test('a path anywhere else is written down absolute', () => {
  expect(storedPath('/mnt/data/ledger.csv', '/home/cpa/q4/books.uno')).toBe(
    '/mnt/data/ledger.csv',
  );
  expect(storedPath('/home/cpa/q3/sales.csv', '/home/cpa/q4/books.uno')).toBe(
    '/home/cpa/q3/sales.csv',
  );
  // A sibling folder with the same name prefix is outside the workspace folder.
  expect(
    storedPath('/home/cpa/q4-old/sales.csv', '/home/cpa/q4/books.uno'),
  ).toBe('/home/cpa/q4-old/sales.csv');
  // A doubled separator is kept whole rather than read as a path from the
  // root.
  expect(storedPath('/home/cpa/q4//sales.csv', '/home/cpa/q4/books.uno')).toBe(
    '/home/cpa/q4//sales.csv',
  );
});

test('a relative path is read back from the folder the workspace is in', () => {
  expect(resolvedPath('sales.csv', '/home/cpa/q4/books.uno')).toBe(
    '/home/cpa/q4/sales.csv',
  );
  expect(resolvedPath('exports/ads.csv', '/home/cpa/q4/books.uno')).toBe(
    '/home/cpa/q4/exports/ads.csv',
  );
  expect(resolvedPath('/mnt/data/ledger.csv', '/home/cpa/q4/books.uno')).toBe(
    '/mnt/data/ledger.csv',
  );
});

// storedPath then resolvedPath against a moved workspace finds the moved file.
test('a folder moved whole still resolves every path it wrote', () => {
  const was = '/home/cpa/q4/books.uno';
  const now = '/media/stick/q4/books.uno';
  const file = '/home/cpa/q4/exports/ads.csv';

  expect(resolvedPath(storedPath(file, was), now)).toBe(
    '/media/stick/q4/exports/ads.csv',
  );
});

// Windows paths are stored with forward slashes and resolve on either platform.
test('a path written on one platform reads on the other', () => {
  expect(
    storedPath('C:\\books\\q4\\sales.csv', 'C:\\books\\q4\\books.uno'),
  ).toBe('sales.csv');
  expect(
    storedPath('C:\\books\\q4\\exports\\ads.csv', 'C:\\books\\q4\\books.uno'),
  ).toBe('exports/ads.csv');
  expect(against('exports/ads.csv', 'C:\\books\\q4')).toBe(
    'C:\\books\\q4/exports/ads.csv',
  );
  expect(isAbsolute('C:\\books\\sales.csv')).toBe(true);
  expect(isAbsolute('\\\\share\\books\\sales.csv')).toBe(true);
  expect(isAbsolute('exports/ads.csv')).toBe(false);
});

// With an empty workspace path, paths are returned unchanged.
test('with nowhere to read it from, a relative path stays as it is', () => {
  expect(resolvedPath('sales.csv', '')).toBe('sales.csv');
  expect(storedPath('/home/cpa/q4/sales.csv', '')).toBe(
    '/home/cpa/q4/sales.csv',
  );
});

test('a path splits into its folder and its name, either way round', () => {
  expect(dirOf('/home/cpa/q4/sales.csv')).toBe('/home/cpa/q4');
  expect(dirOf('C:\\books\\sales.csv')).toBe('C:\\books');
  expect(dirOf('sales.csv')).toBe('');
  expect(baseOf('/home/cpa/q4/sales.csv')).toBe('sales.csv');
  expect(baseOf('C:\\books\\sales.csv')).toBe('sales.csv');
  expect(baseOf('sales.csv')).toBe('sales.csv');
  expect(relativeTo('/home/cpa/q4/sales.csv', '/home/cpa/q4')).toBe(
    'sales.csv',
  );
  expect(
    relativeTo('/home/cpa/q4', '/home/cpa/q4'),
    'a folder is not under itself',
  ).toBe('');
});

// A bucket prefix or a picked folder may end in its separator.
test('a folder written with its separator at the end holds the paths under it', () => {
  expect(
    relativeTo(
      's3://lake/orders/year=2024/part-0.parquet',
      's3://lake/orders/',
    ),
  ).toBe('year=2024/part-0.parquet');
  expect(relativeTo('/data/lake/part-0.parquet', '/data/lake/')).toBe(
    'part-0.parquet',
  );
  expect(relativeTo('C:\\lake\\year=2024\\a.csv', 'C:\\lake\\')).toBe(
    'year=2024/a.csv',
  );
  expect(relativeTo('/data/a.csv', '/')).toBe('data/a.csv');
  expect(relativeTo('/data/lake/', '/data/lake/')).toBe('');
  expect(relativeTo('/data/lake//a.csv', '/data/lake/')).toBe('');
  expect(relativeTo('/data/lakehouse/a.csv', '/data/lake/')).toBe('');
  expect(against('year=2024/part-0.parquet', 's3://lake/orders/')).toBe(
    's3://lake/orders/year=2024/part-0.parquet',
  );
});

// S3 separates a key with '/' alone. A backslash, a drive-like segment and
// a doubled slash are each part of the key, and come back as they went in.
test('a part under a bucket root is stored as the rest of its key, as written', () => {
  const root = 's3://lake/orders/';
  const keys = ['a\\b.parquet', 'c:/a.parquet', '/a.parquet', 'x/s3://y'];
  for (const key of keys) {
    expect(underRoot(root + key, root)).toBe(key);
    expect(onRoot(key, root)).toBe(root + key);
  }
  expect(underRoot('s3://lake/orders\\x.parquet', 's3://lake/orders')).toBe('');
  expect(underRoot('s3://lake/orders/../x.parquet', root)).toBe('');
  expect(onRoot('a.parquet', 's3://lake/orders')).toBe(
    's3://lake/orders/a.parquet',
  );
});

// A folder on disk reads either separator, as a path written on Windows does.
test('a part under a folder root is stored with forward slashes', () => {
  expect(underRoot('C:\\lake\\year=2024\\a.csv', 'C:\\lake\\')).toBe(
    'year=2024/a.csv',
  );
  expect(onRoot('year=2024/a.csv', 'C:\\lake\\')).toBe(
    'C:\\lake\\year=2024/a.csv',
  );
  expect(underRoot('/data/lake/c:/a.parquet', '/data/lake')).toBe(
    'c:/a.parquet',
  );
  expect(onRoot('c:/a.parquet', '/data/lake')).toBe('/data/lake/c:/a.parquet');
  expect(underRoot('/data/lake/../../etc/x.csv', '/data/lake/')).toBe('');
});

// '..' climbs out of a folder, on disk and in an S3 URL alike, and '.' names
// the folder it is in.
test('a path through a dot segment is under no folder', () => {
  expect(relativeTo('/home/cpa/q4/../q3/sales.csv', '/home/cpa/q4')).toBe('');
  expect(relativeTo('/home/cpa/q4/./sales.csv', '/home/cpa/q4')).toBe('');
  expect(relativeTo('s3://lake/q4/../q3/sales.csv', 's3://lake/q4')).toBe('');
  expect(relativeTo('/home/cpa/q4/..x/sales.csv', '/home/cpa/q4')).toBe(
    '..x/sales.csv',
  );
  expect(
    storedPath('/home/cpa/q4/../q3/sales.csv', '/home/cpa/q4/books.uno'),
  ).toBe('/home/cpa/q4/../q3/sales.csv');
});

// A workspace in a bucket stores the sources beside it as S3 keys.
test('a path beside a workspace in a bucket keeps its key as written', () => {
  const at = 's3://lake/q4/books.uno';
  expect(storedPath('s3://lake/q4/a\\b.csv', at)).toBe('a\\b.csv');
  expect(resolvedPath('a\\b.csv', at)).toBe('s3://lake/q4/a\\b.csv');
  // A drive-like key would read back as a path of its own.
  expect(storedPath('s3://lake/q4/c:/a.csv', at)).toBe('s3://lake/q4/c:/a.csv');
});

test('two paths are the same place whichever way their slashes lean', () => {
  expect(samePath('C:\\data\\q4\\sales.csv', 'C:/data/q4/sales.csv')).toBe(
    true,
  );
  expect(samePath('/home/cpa/q4/sales.csv', '/home/cpa/q4/sales.csv')).toBe(
    true,
  );
  expect(samePath('/home/cpa/q4/sales.csv', '/home/cpa/q4/Sales.csv')).toBe(
    false,
  );
  expect(samePath('/home/cpa/q4/sales.csv', '/home/cpa/q4')).toBe(false);
});
