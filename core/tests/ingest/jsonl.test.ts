/**
 * @fileoverview A JSON Lines file reads as one row per line: its indexer
 * gives each key a column in the order keys are first seen, and a decode
 * lays each line out over those columns, with a line that does not lay out
 * in full kept whole in _line, and adds none.
 */

import { describe, expect, test } from 'vite-plus/test';

import { linesFormat } from '@ingest/jsonl';
import { LINE_COLUMN, LINE_KEY } from '@ingest/keys';
import type { KeyedColumn } from '@ingest/keys';
import type { RecordFormat } from '@ingest/records';

const encoder = new TextEncoder();
/** A chunk size past any test file's, which pushes a file whole. */
const WHOLE = Number.MAX_SAFE_INTEGER;

/** What the index pass makes of a file, and the format it read it with. */
interface Indexed {
  readonly format: RecordFormat;
  readonly bytes: Uint8Array;
  /** Where the indexer found each record start. */
  readonly begins: readonly number[];
}

/**
 * indexed feeds `text` to a fresh format's indexer past its byte order mark,
 * `chunk` bytes at a time, and tells it the file has ended unless `ends` is
 * false.
 */
function indexed(
  text: string | Uint8Array,
  chunk = WHOLE,
  pinned: readonly KeyedColumn[] = [],
  ends = true,
): Indexed {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  const format = linesFormat('events.jsonl', bytes, pinned);
  const begins: number[] = [];
  const indexer = format.indexer((offset) => begins.push(offset));
  for (let at = format.dataStart; at < bytes.length; at += chunk) {
    indexer.push(bytes.subarray(at, Math.min(at + chunk, bytes.length)), at);
  }
  if (ends) indexer.end?.();
  return { format, bytes, begins };
}

/** rows decodes every record the indexer found, in one run. */
function rows({ format, bytes, begins }: Indexed): string[][] {
  return begins.length === 0
    ? []
    : format.decode(bytes.subarray(begins[0], bytes.length));
}

/** names returns the names of a format's columns. */
function names(format: RecordFormat): string[] {
  return format.columns().map((column) => column.name);
}

/** Columns a save pinned: a nested key, then a top-level one. */
const PINNED: readonly KeyedColumn[] = [
  { name: 'u.n', key: '/u/n' },
  { name: 'a', key: '/a' },
];
/** The pinned columns and the line column after them. */
const WITH_LINE: readonly KeyedColumn[] = [
  ...PINNED,
  { name: LINE_COLUMN, key: LINE_KEY },
];

describe('a JSON Lines file reads as one row per line', () => {
  test("each cell goes in its key's column, and an absent key's is empty", () => {
    const file = indexed('{"a":1,"u":{"n":"x"}}\n{"a":"3"}\n', WHOLE, PINNED);
    expect(rows(file)).toEqual([
      ['x', '1'],
      ['', '3'],
    ]);
  });

  test('a byte order mark, CRLF and blank lines are not rows', () => {
    const file = indexed(
      '\uFEFF{"a":1}\r\n\r\n \t\r\n{"a":2}\r\n\n',
      WHOLE,
      PINNED,
    );
    expect(file.format.dataStart).toBe(3);
    expect(file.begins).toEqual([3, 18]);
    expect(rows(file)).toEqual([
      ['', '1'],
      ['', '2'],
    ]);
  });

  test('a line that is not one JSON object, or holds a key with no column, is kept whole in _line', () => {
    const { format } = indexed('', WHOLE, WITH_LINE);
    const text = '{"a":1}\n[1,2]\n {"a": \n7\r\n{"a":2,"z":3}';
    expect(format.decode(encoder.encode(text))).toEqual([
      ['', '1', ''],
      ['', '', '[1,2]'],
      ['', '', ' {"a": '],
      ['', '', '7'],
      ['', '2', '{"a":2,"z":3}'],
    ]);
  });

  test('a decode adds no column', () => {
    const { format } = indexed('', WHOLE, PINNED);
    expect(format.decode(encoder.encode('{"a":2,"z":3}\n[]\n'))).toEqual([
      ['', '2'],
      ['', ''],
    ]);
    expect(format.columns()).toEqual(PINNED);
  });

  test('is labelled with its encoding and JSON Lines', () => {
    expect(indexed('{}').format.label()).toEqual({
      t: 'read-lines',
      charset: 'UTF-8',
    });
  });

  test('a UTF-16 file is refused by name', () => {
    const utf16 = Uint8Array.of(0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00);
    expect(() => linesFormat('events.jsonl', utf16, [])).toThrow(
      'events.jsonl: UTF-16 little-endian is not supported yet',
    );
  });
});

describe('the indexer gives each key a column where it is first seen', () => {
  test('in the order keys come, each named by its pointer', () => {
    const file = indexed('{"a":1,"u":{"n":"x"}}\n{"b":true,"a":"3"}\n');
    expect(file.format.columns()).toEqual([
      { name: 'a', key: '/a' },
      { name: 'u.n', key: '/u/n' },
      { name: 'b', key: '/b' },
    ]);
    expect(rows(file)).toEqual([
      ['1', 'x', ''],
      ['3', '', 'true'],
    ]);
  });

  test('and _line where a line that is not one JSON object first comes', () => {
    const file = indexed('{"a":1}\n[1,2]\n{"b":2}');
    expect(names(file.format)).toEqual(['a', LINE_COLUMN, 'b']);
    expect(rows(file)).toEqual([
      ['1', '', ''],
      ['', '[1,2]', ''],
      ['', '', '2'],
    ]);
  });
});
