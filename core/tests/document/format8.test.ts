/**
 * @fileoverview Format 8 tests: a source of several files read in row space,
 * with `join`, `root` and `partitions` keys, and parts that say their rows.
 * Under a root each part's path is stored relative to it. A source that says
 * none of them is written as before, which format6.test.ts and
 * format7.test.ts hold to the byte. Covers what is written, which format it
 * needs, round trips, and the refusals for a part outside its root and a
 * newer format.
 */

import { describe, expect, test } from 'vite-plus/test';

import {
  PARTS_VERSION,
  ROWS_VERSION,
  formatFor,
  readContainer,
  writeDocument,
} from '@document';
import type { HeldPart, HeldParts } from '@document';
import {
  AT,
  manifestOf,
  manifestText,
  partsOf,
  tampered,
  workspace,
} from '@core-tests/document/manifest';

/** The bucket prefix the dataset was found under. */
const ROOT = 's3://lake/orders/';

/** One Parquet part of the dataset, at `under` beneath the root. */
function part(under: string, rows?: number): HeldPart {
  return {
    name: under.slice(under.lastIndexOf('/') + 1),
    path: ROOT + under,
    bytes: 134_217_728,
    version: '"9b2cf5"',
    skip: 0,
    unterminated: false,
    rows,
  };
}

/**
 * A Hive-partitioned dataset of three Parquet parts, read in row space. The
 * last part's rows are not counted yet.
 */
function orders(): HeldParts {
  return {
    id: 'orders',
    name: 'orders',
    connection: 'lake',
    join: 'rows',
    root: ROOT,
    partitions: ['year', 'month'],
    parts: [
      part('year=2024/month=11/part-00000.snappy.parquet', 1_048_576),
      part('year=2024/month=12/part-00000.snappy.parquet', 998_002),
      part('year=2025/month=1/part-00000.snappy.parquet'),
    ],
    header: 'first',
    rows: 2_046_578,
    cols: 14,
    state: { active: { row: 0, col: 0 } },
  };
}

describe('a source read in row space', () => {
  test('needs format 8, the rung for a source read in row space', () => {
    const doc = workspace([orders()]);
    writeDocument(doc);
    expect(doc.manifest.format).toBe(ROWS_VERSION);
    expect(ROWS_VERSION).toBe(8);
  });

  // The full manifest text is compared, so any moved key fails.
  test('is written with its root and keys before its parts, each part relative to the root', () => {
    const uno = writeDocument(workspace([orders()]));
    const m = manifestOf(uno);
    expect(manifestText(uno)).toBe(`{
  "format": 8,
  "generator": "uno 0.2.0",
  "created": "2026-09-30T12:00:00Z",
  "modified": "${m.modified}",
  "sources": [
    {
      "id": "orders",
      "name": "orders",
      "connection": "lake",
      "join": "rows",
      "root": "s3://lake/orders/",
      "partitions": [
        "year",
        "month"
      ],
      "parts": [
        {
          "path": "year=2024/month=11/part-00000.snappy.parquet",
          "bytes": 134217728,
          "version": "\\"9b2cf5\\"",
          "rows": 1048576
        },
        {
          "path": "year=2024/month=12/part-00000.snappy.parquet",
          "bytes": 134217728,
          "version": "\\"9b2cf5\\"",
          "rows": 998002
        },
        {
          "path": "year=2025/month=1/part-00000.snappy.parquet",
          "bytes": 134217728,
          "version": "\\"9b2cf5\\""
        }
      ],
      "header": "first",
      "rows": 2046578,
      "cols": 14
    }
  ],
  "sheet": {
    "entry": "sheet/state.json"
  },
  "edits": {
    "count": 1,
    "entry": "edits/log.jsonl"
  }
}
`);
  });

  // A part with no rows in it is counted, and says so.
  test('writes a part counted at no rows', () => {
    const source = orders();
    source.parts[2] = { ...source.parts[2]!, rows: 0 };
    const m = manifestOf(writeDocument(workspace([source])));
    expect(partsOf(m)[2]!['rows']).toBe(0);
  });

  // skip and unterminated place one part's bytes after another's, which a
  // part read on its own never needs.
  test("leaves out the byte join's skip and unterminated", () => {
    const source = orders();
    source.parts[1] = { ...source.parts[1]!, skip: 118, unterminated: true };
    const m = manifestOf(writeDocument(workspace([source])));
    expect(Object.keys(partsOf(m)[1]!)).toEqual([
      'path',
      'bytes',
      'version',
      'rows',
    ]);
  });

  // Files picked by hand have no root, so each path is stored as a file
  // source's is.
  test('with no root stores each part the way a file source is stored', () => {
    const source: HeldParts = {
      ...orders(),
      root: undefined,
      partitions: undefined,
      parts: [
        { ...part('a.parquet'), path: '/home/cpa/q4/exports/a.parquet' },
        { ...part('b.parquet'), path: '/mnt/data/b.parquet' },
      ],
    };
    const m = manifestOf(writeDocument(workspace([source])));
    expect(m.sources[0]!['root']).toBeUndefined();
    expect(partsOf(m).map((p) => p['path'])).toEqual([
      'exports/a.parquet',
      '/mnt/data/b.parquet',
    ]);
  });

  // A root beside the workspace is stored relative to it, as a file source
  // is, and its parts stay relative to the root.
  test('stores a root beside the workspace relative to it', () => {
    const local = '/home/cpa/q4/lake/orders/';
    const source = orders();
    source.root = local;
    source.parts = source.parts.map((p) => ({
      ...p,
      path: local + p.path.slice(ROOT.length),
    }));
    const m = manifestOf(writeDocument(workspace([source])));
    expect(m.sources[0]!['root']).toBe('lake/orders/');
    expect(partsOf(m)[0]!['path']).toBe(
      'year=2024/month=11/part-00000.snappy.parquet',
    );
  });

  test('needs format 8 for any one of its keys alone', () => {
    const plain: HeldParts = {
      ...orders(),
      join: undefined,
      root: undefined,
      partitions: undefined,
      parts: orders().parts.map((p) => ({ ...p, rows: undefined })),
    };
    expect(formatFor([plain], [])).toBe(PARTS_VERSION);
    const alone: HeldParts[] = [
      { ...plain, join: 'rows' },
      { ...plain, root: ROOT },
      { ...plain, root: ROOT, partitions: [] },
      { ...plain, parts: [{ ...plain.parts[0]!, rows: 1 }] },
    ];
    for (const source of alone)
      expect(formatFor([source], [])).toBe(ROWS_VERSION);
  });
});

describe('a source read in row space is not written', () => {
  test('with a part outside its root, named', () => {
    const source = orders();
    source.parts[1] = {
      ...source.parts[1]!,
      path: 's3://lake/returns/year=2024/part-00000.snappy.parquet',
    };
    expect(() => writeDocument(workspace([source]))).toThrow(
      new Error(
        'orders: part-00000.snappy.parquet (part 2 of 3) is at s3://lake/returns/year=2024/part-00000.snappy.parquet, which is not under s3://lake/orders/',
      ),
    );
  });

  // A bucket whose name starts with the root's is not under it.
  test('with a part in a folder that only starts like its root', () => {
    const source = orders();
    source.parts[0] = {
      ...source.parts[0]!,
      path: 's3://lake/orders-old/part-00000.snappy.parquet',
    };
    expect(() => writeDocument(workspace([source]))).toThrow(
      'which is not under s3://lake/orders/',
    );
  });
});

describe('a source read in row space reads back', () => {
  test('as it was held, with its log', () => {
    const doc = workspace([orders()]);
    const back = readContainer('books.uno', writeDocument(doc), AT);
    expect(back.sources).toEqual(doc.sources);
    expect(back.log).toEqual(doc.log);
  });
});

// Format 9 is newer than this build.
describe('a format 9 file', () => {
  const NEWER = ROWS_VERSION + 1;

  test('is refused by name', () => {
    const uno = tampered(workspace([orders()]), (m) => (m.format = NEWER));
    expect(() => readContainer('books.uno', uno, AT)).toThrow(
      new Error(
        `books.uno was saved by a newer uno (format ${NEWER}, this build reads ${ROWS_VERSION}). Update uno to open it`,
      ),
    );
  });
});
