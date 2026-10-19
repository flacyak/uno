/**
 * @fileoverview Format 8 tests: a source of several files read in row space,
 * with `join`, `root` and `partitions` keys, and parts that say their rows.
 * Under a root each part's path is stored relative to it. A source that says
 * none of them is written as before, which format6.test.ts and
 * format7.test.ts hold to the byte. Covers what is written, which format it
 * needs, round trips at scale and after a move, files from older formats,
 * and the refusals for a part outside its root, partition keys that are not
 * one name each, and a value this build does not know.
 */

import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, test } from 'vite-plus/test';

import {
  LOG_ENTRY,
  MANIFEST_ENTRY,
  PARTS_VERSION,
  ROWS_VERSION,
  STATE_ENTRY,
  formatFor,
  isAbsolute,
  readContainer,
  writeDocument,
} from '@document';
import type { HeldFile, HeldPart, HeldParts } from '@document';
import {
  AT,
  manifestOf,
  manifestText,
  partsOf,
  tampered,
  workspace,
} from '@core-tests/document/manifest';
import type { WrittenManifest } from '@core-tests/document/manifest';

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

/** A folder beside the workspace that the dataset was copied into. */
const BESIDE = '/home/cpa/q4/lake/orders/';

/** The dataset as found in the folder beside the workspace. */
function copied(): HeldParts {
  const source = orders();
  return {
    ...source,
    root: BESIDE,
    parts: source.parts.map((p) => ({
      ...p,
      path: BESIDE + p.path.slice(ROOT.length),
    })),
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
    const m = manifestOf(writeDocument(workspace([copied()])));
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

  test('partitioned by one key twice, named', () => {
    const source: HeldParts = {
      ...orders(),
      partitions: ['year', 'month', 'year'],
    };
    expect(() => writeDocument(workspace([source]))).toThrow(
      new Error('orders is partitioned by year twice'),
    );
  });

  test('partitioned by a key with no name', () => {
    const source: HeldParts = { ...orders(), partitions: ['year', ''] };
    expect(() => writeDocument(workspace([source]))).toThrow(
      new Error('orders: partition key 2 of 2 has no name'),
    );
  });

  test('with a root that has no path', () => {
    const source: HeldParts = { ...orders(), root: '' };
    expect(() => writeDocument(workspace([source]))).toThrow(
      new Error('orders has a root with no path'),
    );
  });

  // A part's key values are read from its path under the root.
  test('partitioned with no root', () => {
    const source: HeldParts = { ...orders(), root: undefined };
    expect(() => writeDocument(workspace([source]))).toThrow(
      new Error('orders is partitioned and has no root to read its keys from'),
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

  // A bucket root is absolute, so it stays where it was.
  test('with its bucket root wherever the workspace has moved to', () => {
    const uno = writeDocument(workspace([orders()]));
    const [back] = readContainer(
      'books.uno',
      uno,
      '/media/stick/q4/books.uno',
    ).sources;
    expect(back!.root).toBe(ROOT);
    expect(back!.parts!.map((p) => p.path)).toEqual(
      orders().parts.map((p) => p.path),
    );
  });

  // A root beside the workspace moves with it, and its parts with the root.
  test('with a root beside the workspace moved along with it', () => {
    const uno = writeDocument(workspace([copied()]));
    const [back] = readContainer(
      'books.uno',
      uno,
      '/media/stick/q4/books.uno',
    ).sources;
    expect(back!.root).toBe('/media/stick/q4/lake/orders/');
    expect(back!.parts![0]!.path).toBe(
      '/media/stick/q4/lake/orders/year=2024/month=11/part-00000.snappy.parquet',
    );
  });

  // A part read on its own has no bytes before it to skip, whatever the
  // file says.
  test("without the byte join's skip and unterminated", () => {
    const uno = tampered(workspace([orders()]), (m) => {
      partsOf(m)[1]!['skip'] = 118;
      partsOf(m)[1]!['unterminated'] = true;
    });
    const [back] = readContainer('books.uno', uno, AT).sources;
    expect(back!.parts![1]).toMatchObject({ skip: 0, unterminated: false });
  });
});

describe('a dataset of 10,000 parts', () => {
  /** How many parts, as a Spark job writes a decade of monthly folders. */
  const PART_COUNT = 10_000;
  /** How many files the job wrote into each year=/month= folder. */
  const PARTS_PER_FOLDER = 84;
  const MONTHS_PER_YEAR = 12;
  const FIRST_YEAR = 2015;
  /** Spark names every file of one write after the job's id. */
  const JOB = '6f1c2b3a-9d4e-4f5a-8b7c-1d2e3f4a5b6c';
  const SPLIT_DIGITS = 5;
  const ETAG_DIGITS = 32;
  const HEX = 16;
  const WAREHOUSE = 's3://acme-lake/warehouse/sales.db/orders/';
  /** The size and rows of the first part. Each later one is a little
   * smaller, so no two are alike. */
  const PART_BYTES = 134_217_728;
  const PART_ROWS = 1_048_576;

  /**
   * What uno.json may weigh for each part, a little over the 245 bytes it
   * weighs today: most of it the file name and the indentation every
   * manifest is written with.
   */
  const MANIFEST_BYTES_PER_PART = 250;
  const MANIFEST_BUDGET = PART_COUNT * MANIFEST_BYTES_PER_PART;
  /** What the .uno itself may weigh, deflated, which is about 130 KB today. */
  const CONTAINER_BUDGET = 140 * 1024;

  function sparkPart(i: number): HeldPart {
    const folder = Math.floor(i / PARTS_PER_FOLDER);
    const year = FIRST_YEAR + Math.floor(folder / MONTHS_PER_YEAR);
    const month = 1 + (folder % MONTHS_PER_YEAR);
    const split = String(i % PARTS_PER_FOLDER).padStart(SPLIT_DIGITS, '0');
    const name = `part-${split}-${JOB}-c000.snappy.parquet`;
    return {
      name,
      path: `${WAREHOUSE}year=${year}/month=${month}/${name}`,
      bytes: PART_BYTES - i,
      version: `"${i.toString(HEX).padStart(ETAG_DIGITS, '0')}"`,
      skip: 0,
      unterminated: false,
      rows: PART_ROWS - i,
    };
  }

  function dataset(): HeldParts {
    return {
      ...orders(),
      root: WAREHOUSE,
      parts: Array.from({ length: PART_COUNT }, (_, i) => sparkPart(i)),
    };
  }

  test('round-trips with every part relative to its root, within budget', () => {
    const doc = workspace([dataset()]);
    const uno = writeDocument(doc);
    const manifest = unzipSync(uno)[MANIFEST_ENTRY]!;
    const m = manifestOf(uno);

    expect(partsOf(m)).toHaveLength(PART_COUNT);
    expect(partsOf(m).some((p) => isAbsolute(String(p['path'])))).toBe(false);
    expect(partsOf(m)[0]!['path']).toBe(
      `year=${FIRST_YEAR}/month=1/${sparkPart(0).name}`,
    );
    expect(manifest.length).toBeLessThan(MANIFEST_BUDGET);
    expect(uno.length).toBeLessThan(CONTAINER_BUDGET);
    expect(readContainer('books.uno', uno, AT).sources).toEqual(doc.sources);
  });
});

/** A .uno whose uno.json is `manifest`, with one source's state and no log. */
function saved(manifest: string, active: string): Uint8Array {
  const state = {
    source: active,
    sheets: [{ source: active, active: { row: 0, col: 0 } }],
  };
  return zipSync({
    [MANIFEST_ENTRY]: strToU8(manifest),
    [STATE_ENTRY]: strToU8(JSON.stringify(state)),
    [LOG_ENTRY]: strToU8(''),
  });
}

// Each manifest is written out as that format's build wrote it.
describe('a file from an older format', () => {
  test('6 still reads, its parts joined as bytes', () => {
    const uno = saved(
      `{
  "format": 6,
  "generator": "uno 0.2.0",
  "sources": [
    {
      "id": "shop-orders",
      "name": "shop-orders",
      "parts": [
        { "path": "exports/orders-2025-10.csv", "bytes": 2040109871, "version": "\\"9b2cf5\\"" },
        { "path": "exports/orders-2025-11.csv", "bytes": 2254857830, "skip": 118, "unterminated": true }
      ],
      "header": "first",
      "rows": 61204418,
      "cols": 11
    }
  ],
  "sheet": { "entry": "sheet/state.json" },
  "edits": { "count": 0, "entry": "edits/log.jsonl" }
}
`,
      'shop-orders',
    );
    const held: HeldParts = {
      id: 'shop-orders',
      name: 'shop-orders',
      parts: [
        {
          name: 'orders-2025-10.csv',
          path: '/home/cpa/q4/exports/orders-2025-10.csv',
          bytes: 2_040_109_871,
          version: '"9b2cf5"',
          skip: 0,
          unterminated: false,
        },
        {
          name: 'orders-2025-11.csv',
          path: '/home/cpa/q4/exports/orders-2025-11.csv',
          bytes: 2_254_857_830,
          skip: 118,
          unterminated: true,
        },
      ],
      header: 'first',
      rows: 61_204_418,
      cols: 11,
      state: { active: { row: 0, col: 0 } },
    };
    expect(readContainer('books.uno', uno, AT).sources).toEqual([held]);
  });

  test('7 still reads, with its pinned columns', () => {
    const uno = saved(
      `{
  "format": 7,
  "generator": "uno 0.2.0",
  "sources": [
    {
      "id": "events",
      "name": "events.jsonl",
      "bytes": 48211904,
      "path": "exports/events.jsonl",
      "rows": 310455,
      "cols": 2,
      "columns": [{ "name": "id" }, { "name": "user.name", "key": "/user/name" }]
    }
  ],
  "sheet": { "entry": "sheet/state.json" },
  "edits": { "count": 0, "entry": "edits/log.jsonl" }
}
`,
      'events',
    );
    const held: HeldFile = {
      id: 'events',
      name: 'events.jsonl',
      path: '/home/cpa/q4/exports/events.jsonl',
      bytes: 48_211_904,
      columns: [{ name: 'id' }, { name: 'user.name', key: '/user/name' }],
      rows: 310_455,
      cols: 2,
      state: { active: { row: 0, col: 0 } },
    };
    expect(readContainer('books.uno', uno, AT).sources).toEqual([held]);
  });
});

// readContainer refuses what this build cannot read, by name, listing what
// it can.
describe('a source read in row space is refused on reading', () => {
  const DECEMBER =
    'books.uno: orders: part 2 of 3 (year=2024/month=12/part-00000.snappy.parquet)';

  const refusals: Array<
    [what: string, change: (m: WrittenManifest) => void, message: string]
  > = [
    [
      'a join this build does not know, by name',
      (m) => (m.sources[0]!['join'] = 'zip'),
      'books.uno: orders: this build does not know join "zip" · it reads "rows"',
    ],
    [
      'a root that is not text',
      (m) => (m.sources[0]!['root'] = ['s3://lake', 'orders']),
      'books.uno: orders: root is not text',
    ],
    [
      'partitions that are not a list',
      (m) => (m.sources[0]!['partitions'] = 'year,month'),
      'books.uno: orders: partitions is not a list of names',
    ],
    [
      'a partition that is not text',
      (m) => (m.sources[0]!['partitions'] = ['year', 12]),
      'books.uno: orders: partitions is not a list of names',
    ],
    [
      'a part whose rows are not a count',
      (m) => (partsOf(m)[1]!['rows'] = 9.5),
      `${DECEMBER}: rows is not a number of rows`,
    ],
    [
      'a part of fewer than no rows',
      (m) => (partsOf(m)[1]!['rows'] = -1),
      `${DECEMBER}: rows is not a number of rows`,
    ],
    [
      'a part compressed in a way this build does not know, by name',
      (m) => (partsOf(m)[1]!['compression'] = 'bzip2'),
      `${DECEMBER}: this build does not know compression "bzip2" · it reads none`,
    ],
    // What a save refuses, an open refuses too. A part's path is always
    // joined onto its root, so only '..' can take it out.
    [
      'a part outside its root, named',
      (m) => (partsOf(m)[1]!['path'] = '../returns/part-00000.parquet'),
      'books.uno: orders: part-00000.parquet (part 2 of 3) is at s3://lake/orders/../returns/part-00000.parquet, which is not under s3://lake/orders/',
    ],
    [
      'a root that has no path',
      (m) => (m.sources[0]!['root'] = ''),
      'books.uno: orders has a root with no path',
    ],
    [
      'partitioned by one key twice, named',
      (m) => (m.sources[0]!['partitions'] = ['month', 'month']),
      'books.uno: orders is partitioned by month twice',
    ],
    [
      'partitioned by a key with no name',
      (m) => (m.sources[0]!['partitions'] = ['']),
      'books.uno: orders: partition key 1 of 1 has no name',
    ],
    [
      'partitioned with no root',
      (m) => delete m.sources[0]!['root'],
      'books.uno: orders is partitioned and has no root to read its keys from',
    ],
  ];

  test.each(refusals)('with %s', (_what, change, message) => {
    const uno = tampered(workspace([orders()]), change);
    expect(() => readContainer('books.uno', uno, AT)).toThrow(
      new Error(message),
    );
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
