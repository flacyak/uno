/**
 * @fileoverview A JSON Lines file reads as one row per line: a decode lays
 * each line out over the columns the file has, with a line that does not lay
 * out in full kept whole in _line, and adds none.
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
});
