/**
 * @fileoverview A JSON Lines file reads as one row per line: its indexer
 * gives each key a column in the order keys are first seen, and a decode
 * lays each line out over those columns, with a line that does not lay out
 * in full kept whole in _line, and adds none. Over random files of broken
 * lines, a decode finds as many rows as the scanner found records, so a
 * block never reads as changed on disk.
 */

import { describe, expect, test } from 'vite-plus/test';

import { walkLine } from '@ingest/json';
import { linesFormat } from '@ingest/jsonl';
import { JSON_COLUMNS_LIMIT, LINE_COLUMN, LINE_KEY } from '@ingest/keys';
import type { KeyedColumn } from '@ingest/keys';
import { splitLines } from '@ingest/lines';
import type { RecordFormat } from '@ingest/records';
import { pick, random, upTo } from '@core-tests/random';
import type { Random } from '@core-tests/random';
import { starts } from './chunks.ts';
import { jsonish } from './jsonish.ts';

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

  test('up to the limit, past which a line fills what it can and is kept whole in _line', () => {
    const keys = Array.from({ length: JSON_COLUMNS_LIMIT + 1 }, (_, i) => i);
    const wide = `{${keys.map((i) => `"k${i}":${i}`).join(',')}}`;
    const late = `{"k0":"x","k${JSON_COLUMNS_LIMIT}":"y"}`;
    const file = indexed(`${wide}\n${late}\n`);
    const columns = names(file.format);
    expect(columns).toHaveLength(JSON_COLUMNS_LIMIT + 1);
    expect(columns.at(-1)).toBe(LINE_COLUMN);
    const [first, second] = rows(file);
    expect(first).toEqual([...keys.slice(0, -1).map(String), wide]);
    expect(second![0]).toBe('x');
    expect(second!.at(-1)).toBe(late);
  });

  test('the last line, with no LF, once the file has ended', () => {
    const text = '{"a":1}\n{"b":2}';
    expect(names(indexed(text, 1, [], false).format)).toEqual(['a']);
    expect(names(indexed(text, 1).format)).toEqual(['a', 'b']);
  });

  test('and a pinned key keeps its column wherever it first appears', () => {
    const file = indexed('{"b":2,"a":1}\n', WHOLE, PINNED);
    expect(names(file.format)).toEqual(['u.n', 'a', 'b']);
    expect(rows(file)).toEqual([['', '1', '2']]);
  });
});

/** Number of random files to check. */
const SEEDS = 1000;
/** The most lines a random file holds. */
const MOST_LINES = 8;
/** Chance a random file starts with a byte order mark. */
const BOM_CHANCE = 0.1;
/** Chance a random line has the LFs between its tokens made spaces. The
 * rest are split where an LF falls, as JSON Lines splits them. */
const ONE_LINE_CHANCE = 0.8;
/** What follows a random line: nothing, so the next joins it, line ends,
 * and blank lines. */
const ENDINGS = ['', '\n', '\r\n', '\n\n', ' \t\r\n', '\n\r\n'];
/** Bytes per push: one at a time, a few, and more than most files hold. */
const CHUNK_SIZES = [1, 7, 64];
/** How many records apart a file is cut into blocks decoded on their own. */
const CUT_EVERY = [1, 2, 3];
/** The least share of random lines that must lay out in full, and that must not. */
const LEAST_SHARE = 0.1;
/** Decodes a file's text past its byte order mark, as the engine does. */
const data = new TextDecoder('utf-8', { ignoreBOM: true });

/** jsonLines returns a random JSON Lines file of random, often broken, lines. */
function jsonLines(rand: Random): Uint8Array {
  let text = rand() < BOM_CHANCE ? '\uFEFF' : '';
  const count = upTo(rand, MOST_LINES);
  for (let i = 0; i < count; i++) {
    const line = jsonish(rand);
    text += rand() < ONE_LINE_CHANCE ? line.replaceAll('\n', ' ') : line;
    text += pick(rand, ENDINGS);
  }
  return encoder.encode(text);
}

/**
 * blocks decodes the records of `file` in blocks of `every` records, each on
 * its own as Pages reads them, and checks each holds as many rows as records.
 */
function blocks(file: Indexed, every: number, seed: number): string[][] {
  const { format, bytes, begins } = file;
  const out: string[][] = [];
  for (let i = 0; i < begins.length; i += every) {
    const end = begins[i + every] ?? bytes.length;
    const block = format.decode(bytes.subarray(begins[i], end));
    const want = Math.min(every, begins.length - i);
    expect(block, `seed ${seed}, every ${every}, at ${i}`).toHaveLength(want);
    out.push(...block);
  }
  return out;
}

describe('over random files of broken lines', () => {
  test('a decode finds a row for each record the scanner finds, in any chunk size and any block', () => {
    const laidOut = { whole: 0, kept: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const bytes = jsonLines(random(seed));
      const file = indexed(bytes);
      const { format, begins } = file;
      const columns = format.columns();
      const scanned = starts((begin) => format.scanner(begin), bytes, 1);
      expect(begins, `seed ${seed}`).toEqual(scanned);

      for (const chunk of CHUNK_SIZES) {
        const again = indexed(bytes, chunk);
        expect(again.begins, `seed ${seed}, chunk ${chunk}`).toEqual(begins);
        expect(again.format.columns()).toEqual(columns);
      }

      const all = rows(file);
      expect(all, `seed ${seed}`).toHaveLength(begins.length);
      for (const every of CUT_EVERY) {
        expect(blocks(file, every, seed)).toEqual(all);
      }
      expect(format.columns()).toEqual(columns);

      // A line walkLine refuses is kept whole in _line.
      const lines = splitLines(data.decode(bytes.subarray(format.dataStart)));
      const line = columns.findIndex((column) => column.key === LINE_KEY);
      lines.forEach((text, i) => {
        const whole = walkLine(text, () => undefined);
        if (!whole) expect(all[i]![line], `seed ${seed}`).toBe(text);
        laidOut[whole ? 'whole' : 'kept']++;
      });
    }
    const lines = laidOut.whole + laidOut.kept;
    expect(laidOut.whole).toBeGreaterThan(lines * LEAST_SHARE);
    expect(laidOut.kept).toBeGreaterThan(lines * LEAST_SHARE);
  });
});
