/**
 * @fileoverview The line scanner agrees with splitLines on blank lines, line
 * endings and a byte order mark, fed whole or a byte at a time.
 */

import { describe, expect, test } from 'vite-plus/test';

import { LineScanner, splitLines } from '@ingest/lines';
import { starts } from './chunks.ts';

const encoder = new TextEncoder();
const whole = new TextDecoder('utf-8');

describe('the line scanner agrees with splitLines', () => {
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
      const scanner = (begin: (offset: number) => void) =>
        new LineScanner(begin);
      expect(starts(scanner, bytes, bytes.length)).toEqual(begins);
      // Feeding one byte at a time gives the same offsets.
      expect(starts(scanner, bytes, 1)).toEqual(begins);
      expect(splitLines(whole.decode(bytes))).toEqual(lines);
    });
  }
});
