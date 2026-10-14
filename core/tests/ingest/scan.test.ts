/**
 * @fileoverview The record scanner agrees with readAll over random input, in
 * any chunk size, split at any record.
 */

import { describe, expect, test } from 'vite-plus/test';

import { readAll } from '@ingest/csv';
import { RecordScanner } from '@ingest/scan';
import { piecewise, starts } from './chunks.ts';
import type { Random } from './random.ts';
import { random } from './random.ts';

const encoder = new TextEncoder();
const whole = new TextDecoder('utf-8');

// Every byte the scanner acts on, plus multi-byte letters and a U+FEFF that
// can land anywhere in the file.
const ALPHABET = [
  'a',
  'b',
  ',',
  ';',
  '"',
  '"',
  '\n',
  '\n',
  '\r',
  '\r\n',
  ' ',
  'é',
  '日',
  '\uFEFF',
];

/** Chance a random file starts with a byte order mark, and its maximum length. */
const BOM_CHANCE = 0.1;
const MAX_CHARS = 40;

/** Number of random files to check. */
const SEEDS = 4000;

/** csvish returns a random file of the alphabet's characters. */
function csvish(rand: Random): string {
  let s = rand() < BOM_CHANCE ? '\uFEFF' : '';
  const n = Math.floor(rand() * MAX_CHARS);
  for (let i = 0; i < n; i++)
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

describe('the scanner agrees with readAll', () => {
  test('on random input, in any chunk size, split at any record', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed);
      const text = csvish(rand);
      const comma = rand() < 0.5 ? ',' : ';';
      const bytes = encoder.encode(text);
      const want = readAll(whole.decode(bytes), comma);

      for (const chunk of [1, 2, 7, 64]) {
        const begins = starts(
          (begin) => new RecordScanner(comma, begin),
          bytes,
          chunk,
        );
        expect(
          begins.length,
          `seed ${seed}, chunk ${chunk}: ${JSON.stringify(text)}`,
        ).toBe(want.length);
        for (const every of [1, 2, 3]) {
          expect(
            piecewise(bytes, begins, every, (run) => readAll(run, comma)),
            `seed ${seed}, chunk ${chunk}, every ${every}: ${JSON.stringify(text)}`,
          ).toEqual(want);
        }
      }
    }
  });

  const cases: Array<[string, string, number[]]> = [
    ['one record per line', 'a,b\n1,2\n', [0, 4]],
    ['blank lines are not records', 'a\n\n\r\nb\n', [0, 5]],
    [
      'a quoted newline stays inside its record',
      'a\n"x\ny",1\nz\n',
      [0, 2, 10],
    ],
    ['a doubled quote does not close the field', 'a\n"x"",\ny"\nz', [0, 2, 11]],
    ['a bare quote in an unquoted field is data', 'a\nx",\n"b"\n', [0, 2, 6]],
    ['a lone CR at the end of the file is not a record', 'a\n\r', [0]],
    ['a CR that is not a line ending begins a record', 'a\n\rb\n', [0, 2]],
    [
      'the byte order mark is not part of the first record',
      '\uFEFF"a,b"\nc\n',
      [3, 9],
    ],
  ];

  for (const [name, text, want] of cases) {
    test(name, () => {
      const bytes = encoder.encode(text);
      const scanner = (begin: (offset: number) => void) =>
        new RecordScanner(',', begin);
      expect(starts(scanner, bytes, bytes.length)).toEqual(want);
      // Feeding one byte at a time gives the same offsets.
      expect(starts(scanner, bytes, 1)).toEqual(want);
    });
  }
});

test('the scanner refuses a separator it cannot scan for', () => {
  for (const comma of ['"', '\n', 'é', ',,']) {
    expect(() => new RecordScanner(comma, () => {})).toThrow(
      'cannot separate fields',
    );
  }
});
