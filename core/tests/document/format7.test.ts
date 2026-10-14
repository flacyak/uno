/**
 * @fileoverview Format 7 tests: a source that says how its rows were read,
 * with `kind`, `compression` and pinned `columns` keys. A source that says
 * none of them is written as before, which format6.test.ts holds to the
 * byte. Covers where each key is written and which format it needs.
 */

import { describe, expect, test } from 'vite-plus/test';

import { READ_VERSION, formatFor, writeDocument } from '@document';
import type { HeldFile, HeldParts, SavedColumn } from '@document';
import {
  manifestOf,
  manifestText,
  workspace,
} from '@core-tests/document/manifest';

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
 * A pointed-at file whose columns were learned from its rows. No kind is
 * known to this build, so it says how it was read by its columns alone.
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
