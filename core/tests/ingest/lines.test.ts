/**
 * @fileoverview The line scanner agrees with splitLines over random input,
 * in any chunk size, split at any record, and on blank lines, line endings
 * and a byte order mark.
 */

import { describe, expect, test } from 'vite-plus/test';

import { LineScanner, splitLines } from '@ingest/lines';
import { piecewise, starts } from './chunks.ts';
import type { Random } from '@core-tests/random';
import { random } from '@core-tests/random';

const encoder = new TextEncoder();
const whole = new TextDecoder('utf-8');
/** Makes the line scanner each test feeds. */
const scanner = (begin: (offset: number) => void) => new LineScanner(begin);

/** A byte that is never valid UTF-8, which decodes to U+FFFD. */
const INVALID = 0xff;
/** The lead byte of a three-byte character, cut off before its other two. */
const CUT_LEAD = 0xe6;

// Every byte the scanner acts on, a quote whose string would hold an LF,
// multi-byte letters, bytes that are not UTF-8, and a U+FEFF that can land
// anywhere in the file.
const ALPHABET: readonly Uint8Array[] = [
  ...[
    '{',
    'a',
    '"',
    '\n',
    '\n',
    '\r',
    '\r\n',
    ' ',
    '\t',
    'é',
    '日',
    '\uFEFF',
  ].map((s) => encoder.encode(s)),
  Uint8Array.of(INVALID),
  Uint8Array.of(CUT_LEAD),
];

/** The UTF-8 byte order mark. */
const BOM = encoder.encode('\uFEFF');
/** Chance a random file starts with a byte order mark. */
const BOM_CHANCE = 0.1;
/** The most pieces of the alphabet a random file holds. */
const MAX_PIECES = 40;

/** Number of random files to check. */
const SEEDS = 4000;
/** Bytes per push: one at a time, a few, and more than most files hold. */
const CHUNK_SIZES = [1, 2, 7, 64];
/** How many records apart a file is cut into runs decoded on their own. */
const CUT_EVERY = [1, 2, 3];

/** linesish is a random file of the alphabet's pieces. */
function linesish(rand: Random): Uint8Array {
  const bytes: number[] = rand() < BOM_CHANCE ? [...BOM] : [];
  const n = Math.floor(rand() * MAX_PIECES);
  for (let i = 0; i < n; i++)
    bytes.push(...ALPHABET[Math.floor(rand() * ALPHABET.length)]!);
  return Uint8Array.from(bytes);
}

describe('the line scanner agrees with splitLines', () => {
  test('on random input, in any chunk size, split at any record', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const bytes = linesish(random(seed));
      const want = splitLines(whole.decode(bytes));
      const shown = JSON.stringify(Array.from(bytes));

      for (const chunk of CHUNK_SIZES) {
        const begins = starts(scanner, bytes, chunk);
        expect(begins.length, `seed ${seed}, chunk ${chunk}: ${shown}`).toBe(
          want.length,
        );
        for (const every of CUT_EVERY) {
          expect(
            piecewise(bytes, begins, every, splitLines),
            `seed ${seed}, chunk ${chunk}, every ${every}: ${shown}`,
          ).toEqual(want);
        }
      }
    }
  });

  const cases: Array<[string, string, number[], string[]]> = [
    [
      'one record per line',
      '{"a":1}\n{"a":2}\n',
      [0, 8],
      ['{"a":1}', '{"a":2}'],
    ],
    [
      'whitespace-only lines are not records',
      '{}\n\n \t\r\n{}\n',
      [0, 8],
      ['{}', '{}'],
    ],
    [
      'CRLF ends a line, and the CR is left off',
      '{}\r\n{}\r\n',
      [0, 4],
      ['{}', '{}'],
    ],
    [
      'a record starts at its line, blanks before it included',
      '{}\n \t{}\n',
      [0, 3],
      ['{}', ' \t{}'],
    ],
    ['the last line needs no LF', '{}\n{"a":1}', [0, 3], ['{}', '{"a":1}']],
    ['a whitespace-only last line is not a record', '{}\n \r', [0], ['{}']],
    [
      'an LF ends a line inside a string, which JSON forbids',
      '{"a":"x\ny"}\n',
      [0, 8],
      ['{"a":"x', 'y"}'],
    ],
    [
      'the byte order mark is not part of the first record',
      '\uFEFF{}\n{}\n',
      [3, 6],
      ['{}', '{}'],
    ],
    [
      'a line holding only a byte order mark is blank',
      '\uFEFF\r\n{}',
      [5],
      ['{}'],
    ],
    [
      'a U+FEFF past the first byte is data',
      '{}\n\uFEFF\n',
      [0, 3],
      ['{}', '\uFEFF'],
    ],
  ];

  for (const [name, text, begins, lines] of cases) {
    test(name, () => {
      const bytes = encoder.encode(text);
      expect(starts(scanner, bytes, bytes.length)).toEqual(begins);
      // Feeding one byte at a time gives the same offsets.
      expect(starts(scanner, bytes, 1)).toEqual(begins);
      expect(splitLines(whole.decode(bytes))).toEqual(lines);
    });
  }
});
