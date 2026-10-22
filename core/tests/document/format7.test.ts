/**
 * @fileoverview Format 7 tests: a source that says how its rows were read,
 * with `kind`, `compression` and pinned `columns` keys. A source that says
 * none of them is written as before, which format6.test.ts holds to the
 * byte. Covers where each key is written, which format it needs, round
 * trips, and the refusals for a value this build does not know.
 */

import { describe, expect, test } from 'vite-plus/test';

import {
  READ_VERSION,
  formatFor,
  readContainer,
  writeDocument,
} from '@document';
import type {
  HeldFile,
  HeldParts,
  SavedColumn,
  SourceCompression,
  SourceKind,
} from '@document';
import {
  AT,
  manifestOf,
  manifestText,
  tampered,
  workspace,
} from '@core-tests/document/manifest';
import type { WrittenManifest } from '@core-tests/document/manifest';

/**
 * Columns learned from the rows: a top-level field, a nested field and the
 * column that holds a line whole. The nested field's keys are in the other
 * order, which the manifest does not follow.
 */
function learned(): SavedColumn[] {
  return [
    { name: 'id' },
    { key: '/user/name', name: 'user.name' },
    { name: '_line', key: '' },
  ];
}

/** The columns as uno.json pins them. */
const PINNED = [
  { name: 'id' },
  { name: 'user.name', key: '/user/name' },
  { name: '_line', key: '' },
];

/**
 * A pointed-at file whose columns were learned from its rows, which says
 * how it was read by its columns alone.
 */
function events(): HeldFile {
  return {
    id: 'events',
    name: 'events.jsonl',
    path: '/home/cpa/q4/exports/events.jsonl',
    bytes: 48_211_904,
    version: '"5e0c2a"',
    columns: learned(),
    rows: 310_455,
    cols: 3,
    state: { active: { row: 0, col: 0 } },
  };
}

/** Two files read as one, with the columns learned from their rows. */
function shards(): HeldParts {
  return {
    id: 'shards',
    name: 'shards',
    parts: [
      {
        name: 'shard-0.jsonl',
        path: '/data/shards/shard-0.jsonl',
        bytes: 1_048_576,
        skip: 0,
        unterminated: false,
      },
      {
        name: 'shard-1.jsonl',
        path: '/data/shards/shard-1.jsonl',
        bytes: 917_504,
        skip: 0,
        unterminated: true,
      },
    ],
    header: 'none',
    columns: learned(),
    rows: 40_960,
    cols: 3,
    state: { active: { row: 0, col: 0 } },
  };
}

describe('a source with pinned columns', () => {
  test('needs format 7, the rung for a source that says how it was read', () => {
    const doc = workspace([events()]);
    writeDocument(doc);
    expect(doc.manifest.format).toBe(READ_VERSION);
    expect(READ_VERSION).toBe(7);
  });

  // The full manifest text is compared, so any moved key fails.
  test('is written with its columns after its shape, each key only where it is set', () => {
    const uno = writeDocument(workspace([events()]));
    const m = manifestOf(uno);
    expect(manifestText(uno)).toBe(`{
  "format": 7,
  "generator": "uno 0.2.0",
  "created": "2026-09-30T12:00:00Z",
  "modified": "${m.modified}",
  "sources": [
    {
      "id": "events",
      "name": "events.jsonl",
      "bytes": 48211904,
      "path": "exports/events.jsonl",
      "version": "\\"5e0c2a\\"",
      "rows": 310455,
      "cols": 3,
      "columns": [
        {
          "name": "id"
        },
        {
          "name": "user.name",
          "key": "/user/name"
        },
        {
          "name": "_line",
          "key": ""
        }
      ]
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

  test('of several files read as one keeps its header and pins them after its shape', () => {
    const m = manifestOf(writeDocument(workspace([shards()])));
    expect(m.format).toBe(READ_VERSION);
    expect(Object.keys(m.sources[0]!)).toEqual([
      'id',
      'name',
      'parts',
      'header',
      'rows',
      'cols',
      'columns',
    ]);
    expect(m.sources[0]!['header']).toBe('none');
    expect(m.sources[0]!['columns']).toEqual(PINNED);
  });

  // The layout before format 4 has no place for columns.
  test('carried alone is written in the layout of several sources', () => {
    const carried: HeldFile = {
      ...events(),
      path: undefined,
      bytes: undefined,
      version: undefined,
      raw: new TextEncoder().encode('{"id":1,"user":{"name":"ada"}}\n'),
    };
    const m = manifestOf(writeDocument(workspace([carried])));
    expect(m.format).toBe(READ_VERSION);
    expect(m.sources[0]!['entry']).toBe('data/source/events.jsonl');
    expect(m.sources[0]!['columns']).toEqual(PINNED);
  });

  // An empty list is pinned too: a source that has learned no columns yet.
  test('beside a source of several files still needs format 7', () => {
    const plain: HeldParts = { ...shards(), columns: undefined };
    expect(formatFor([plain, events()], [])).toBe(READ_VERSION);
    expect(formatFor([plain, { ...events(), columns: [] }], [])).toBe(
      READ_VERSION,
    );
  });
});

/** The pinned columns of the first source of a written manifest. */
function columnsOf(m: WrittenManifest): Array<Record<string, unknown>> {
  return m.sources[0]!['columns'] as Array<Record<string, unknown>>;
}

describe('a source with pinned columns reads back', () => {
  test('as it was held, from one file', () => {
    const doc = workspace([events()]);
    const [back] = readContainer('books.uno', writeDocument(doc), AT).sources;
    expect(back).toEqual(doc.sources[0]);
    // A key left out stays out, and a key of "" stays "".
    expect(back!.columns).toStrictEqual(PINNED);
  });

  test('as it was held, from several files', () => {
    const doc = workspace([shards(), events()]);
    const back = readContainer('books.uno', writeDocument(doc), AT);
    expect(back.sources).toEqual(doc.sources);
    expect(back.log).toEqual(doc.log);
  });
});

// readContainer refuses what this build cannot read, by name, listing what
// it can.
describe('a source that says how it was read is refused on reading', () => {
  const refusals: Array<
    [what: string, change: (m: WrittenManifest) => void, message: string]
  > = [
    [
      'a kind this build does not know, by name',
      (m) => (m.sources[0]!['kind'] = 'avro'),
      'books.uno: events.jsonl: this build does not know kind "avro" · it reads "jsonl"',
    ],
    [
      'a kind that is not text',
      (m) => (m.sources[0]!['kind'] = 7),
      'books.uno: events.jsonl: this build does not know kind 7 · it reads "jsonl"',
    ],
    [
      'a compression this build does not know, by name',
      (m) => (m.sources[0]!['compression'] = 'lz4'),
      'books.uno: events.jsonl: this build does not know compression "lz4" · it reads none',
    ],
    [
      'a kind this build does not know on several files',
      (m) => (m.sources[1]!['kind'] = 'avro'),
      'books.uno: shards: this build does not know kind "avro" · it reads "jsonl"',
    ],
    // The kind is read first: only delimited text has to say header.
    [
      'a kind this build does not know on several files with no header',
      (m) => {
        m.sources[1]!['kind'] = 'avro';
        delete m.sources[1]!['header'];
      },
      'books.uno: shards: this build does not know kind "avro" · it reads "jsonl"',
    ],
    [
      'columns that are not a list',
      (m) => (m.sources[0]!['columns'] = 'id,user.name,_line'),
      'books.uno: events.jsonl: columns is not a list of columns',
    ],
    [
      'a column that is not one',
      (m) =>
        (columnsOf(m)[1] = 'user.name' as unknown as Record<string, unknown>),
      'books.uno: events.jsonl: column 2 of 3 is not a column with a name',
    ],
    [
      'a column with no name',
      (m) => delete columnsOf(m)[1]!['name'],
      'books.uno: events.jsonl: column 2 of 3 has no name',
    ],
    [
      'a column whose key is not text',
      (m) => (columnsOf(m)[1]!['key'] = ['user', 'name']),
      'books.uno: events.jsonl: column 2 of 3 (user.name): key is not text',
    ],
  ];

  test.each(refusals)('with %s', (_what, change, message) => {
    const uno = tampered(workspace([events(), shards()]), change);
    expect(() => readContainer('books.uno', uno, AT)).toThrow(
      new Error(message),
    );
  });
});

/** JSON Lines, the kind a source says it was read as. */
const KIND: SourceKind = 'jsonl';
/**
 * A compression no build reads yet, cast in to see where the writer puts
 * it. It joins its type in the change that reads it.
 */
const COMPRESSION = 'gzip' as SourceCompression;

describe('a source with a kind', () => {
  // The full manifest text is compared, so any moved key fails.
  test('of one file is written with its kind and compression after its path, to the byte', () => {
    const source: HeldFile = {
      ...events(),
      kind: KIND,
      compression: COMPRESSION,
      columns: undefined,
    };
    const uno = writeDocument(workspace([source]));
    const m = manifestOf(uno);
    expect(manifestText(uno)).toBe(`{
  "format": 7,
  "generator": "uno 0.2.0",
  "created": "2026-09-30T12:00:00Z",
  "modified": "${m.modified}",
  "sources": [
    {
      "id": "events",
      "name": "events.jsonl",
      "bytes": 48211904,
      "path": "exports/events.jsonl",
      "version": "\\"5e0c2a\\"",
      "kind": "jsonl",
      "compression": "gzip",
      "rows": 310455,
      "cols": 3
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

  // Only delimited text, which has no kind, has a header row to say.
  test('of several files is written with its kind after its parts, and no header', () => {
    const m = manifestOf(
      writeDocument(workspace([{ ...shards(), kind: KIND }])),
    );
    expect(Object.keys(m.sources[0]!)).toEqual([
      'id',
      'name',
      'parts',
      'kind',
      'rows',
      'cols',
      'columns',
    ]);
    expect(m.sources[0]!['kind']).toBe('jsonl');
  });

  test('of JSON Lines reads back as it was held, with its pinned columns', () => {
    const doc = workspace([{ ...events(), kind: KIND }]);
    const [back] = readContainer('books.uno', writeDocument(doc), AT).sources;
    expect(back).toEqual(doc.sources[0]);
    expect(back!.kind).toBe('jsonl');
  });
});
