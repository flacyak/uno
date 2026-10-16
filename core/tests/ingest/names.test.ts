/**
 * @fileoverview A file's name splits into its stem, its data extension and the
 * compression it claims, and says whether uno reads it.
 */

import { describe, expect, test } from 'vite-plus/test';

import {
  DIALOG_EXTENSIONS,
  READ_EXTENSIONS,
  nameParts,
  readable,
} from '@ingest/names';

describe('a name', () => {
  test('peels a compression off its data extension', () => {
    expect(nameParts('q3.tsv.gz')).toEqual({
      stem: 'q3',
      extension: '.tsv',
      suffix: '.tsv.gz',
      compression: 'gzip',
    });
    expect(nameParts('events.jsonl.zst')).toEqual({
      stem: 'events',
      extension: '.jsonl',
      suffix: '.jsonl.zst',
      compression: 'zstd',
    });
    expect(nameParts('q3.gz')).toEqual({
      stem: 'q3',
      extension: '',
      suffix: '.gz',
      compression: 'gzip',
    });
  });

  test('ending in .parquet is Parquet, whatever comes before it', () => {
    expect(nameParts('part-0-c000.snappy.parquet')).toEqual({
      stem: 'part-0-c000.snappy',
      extension: '.parquet',
      suffix: '.parquet',
    });
    expect(nameParts('a.gz.parquet')).toEqual({
      stem: 'a.gz',
      extension: '.parquet',
      suffix: '.parquet',
    });
  });

  test('is read from the last part of a path, whichever its separators', () => {
    expect(nameParts('/home/jo/v1.2/README')).toEqual({
      stem: 'README',
      extension: '',
      suffix: '',
    });
    expect(nameParts('/home/jo/v1.2/q3.csv')).toEqual({
      stem: 'q3',
      extension: '.csv',
      suffix: '.csv',
    });
    expect(nameParts('s3://acme-exports/2025.q3/sales.csv.gz')).toEqual({
      stem: 'sales',
      extension: '.csv',
      suffix: '.csv.gz',
      compression: 'gzip',
    });
    expect(nameParts('C:\\exports\\v1.2\\ads.tsv')).toEqual({
      stem: 'ads',
      extension: '.tsv',
      suffix: '.tsv',
    });
  });

  test('ending in a separator is its folder', () => {
    expect(nameParts('s3://acme-exports/events/')).toEqual({
      stem: 'events',
      extension: '',
      suffix: '',
    });
    expect(nameParts('C:\\exports\\2025\\')).toEqual({
      stem: '2025',
      extension: '',
      suffix: '',
    });
  });

  test('keeps its stem and suffix as written and folds its extension to lower case', () => {
    expect(nameParts('Sales Q3.TSV.GZ')).toEqual({
      stem: 'Sales Q3',
      extension: '.tsv',
      suffix: '.TSV.GZ',
      compression: 'gzip',
    });
  });

  test('with no extension is all stem', () => {
    expect(nameParts('README')).toEqual({
      stem: 'README',
      extension: '',
      suffix: '',
    });
    expect(nameParts('')).toEqual({ stem: '', extension: '', suffix: '' });
    // A leading dot starts a hidden file's name.
    expect(nameParts('.csv')).toEqual({
      stem: '.csv',
      extension: '',
      suffix: '',
    });
  });
});

describe('a readable name', () => {
  test('ends in a read extension, in any case', () => {
    expect(readable('q3.csv')).toBe(true);
    expect(readable('Q3.TSV')).toBe(true);
    expect(readable('s3://acme-exports/2025/q3.csv')).toBe(true);
  });

  test('is not a hidden file, a name with no extension or another format', () => {
    expect(readable('.csv')).toBe(false);
    expect(readable('README')).toBe(false);
    expect(readable('report.pdf')).toBe(false);
  });

  test('is not an archive, nor under a compression uno does not read', () => {
    expect(readable('logs.tar.gz')).toBe(false);
    expect(readable('q3.csv.bz2')).toBe(false);
    expect(readable('q3.csv.xz')).toBe(false);
  });

  test('ends in an extension the dialogs list', () => {
    const listed = DIALOG_EXTENSIONS.map((extension) => `.${extension}`);
    for (const extension of READ_EXTENSIONS) {
      expect(readable(`q3${extension}`)).toBe(true);
      expect(listed).toContain(extension);
    }
  });
});
