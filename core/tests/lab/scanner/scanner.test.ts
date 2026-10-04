/**
 * @fileoverview Every scanner variant is exactly equivalent to RecordScanner:
 * the same begins, byte for byte, and the same state after every push, over
 * random input in many chunk sizes and alignments, the named cases of
 * tests/ingest/scan.test.ts, and every benchmark shape. And BulkIndex, which
 * the bulk variants report to in the benchmark, builds the blocks RowIndex
 * builds.
 */

import { describe, expect, test } from 'vite-plus/test';

import { RowIndex } from '@engine/rows';
import { bomLength } from '@ingest/scan';
import { BulkIndex } from './bulk.ts';
import { LINE_CR } from './common.ts';
import type { Consumer, LabScanner, State } from './common.ts';
import { SHAPES, random } from './shapes.ts';
import { BASELINE, VARIANTS, variantNamed } from './variants.ts';
import type { Variant } from './variants.ts';

const encoder = new TextEncoder();

/** What a scan reports: every begin, and the state after every push. */
interface Trace {
  readonly begins: number[];
  readonly states: Array<[State, number | undefined]>;
}

/** How chunks are cut from the file. */
interface Cutting {
  /** Bytes per push. */
  readonly chunk: number;
  /** Bytes of padding before the file in its buffer, to move its alignment. */
  readonly shift: number;
  /** Whether each chunk is copied into a buffer of its own. */
  readonly fresh: boolean;
}

/** collecting is a Consumer that appends every begin to `out`. */
function collecting(out: number[]): Consumer {
  return {
    begin: (offset) => out.push(offset),
    many: (begins, count, base) => {
      for (let k = 0; k < count; k++) out.push(base + begins[k]!);
    },
  };
}

/** placed copies `bytes` into a buffer `shift` bytes in. */
function placed(bytes: Uint8Array, shift: number): Uint8Array {
  const buffer = new Uint8Array(shift + bytes.length);
  buffer.set(bytes, shift);
  return buffer.subarray(shift);
}

/** trace scans `bytes` from past any byte order mark, cut as `cutting` says. */
function trace(
  variant: Variant,
  bytes: Uint8Array,
  comma: string,
  cutting: Cutting,
): Trace {
  const begins: number[] = [];
  const states: Trace['states'] = [];
  const scanner: LabScanner = variant.make(comma, collecting(begins));
  const file = placed(bytes, cutting.shift);
  for (let at = bomLength(file); at < file.length; at += cutting.chunk) {
    const piece = file.subarray(at, Math.min(at + cutting.chunk, file.length));
    scanner.push(cutting.fresh ? piece.slice() : piece, at);
    const s = scanner.state;
    states.push([s, s === LINE_CR ? scanner.crAt : undefined]);
  }
  return { begins, states };
}

const baseline = variantNamed(BASELINE);
const others = VARIANTS.filter((v) => v.name !== BASELINE);

/** Entries shown either side of the first difference. */
const CONTEXT = 3;

/**
 * same expects two lists to be equal. It compares them in a plain loop and
 * hands expect only the neighbourhood of the first difference, which keeps
 * lists of a million begins fast to check and short to report.
 */
function same<T>(
  got: readonly T[],
  want: readonly T[],
  equal: (a: T, b: T) => boolean,
  where: string,
): void {
  const n = Math.max(got.length, want.length);
  for (let k = 0; k < n; k++) {
    if (k < got.length && k < want.length && equal(got[k]!, want[k]!)) continue;
    const from = Math.max(0, k - CONTEXT);
    expect(
      got.slice(from, k + CONTEXT),
      `${where}, from entry ${from}`,
    ).toEqual(want.slice(from, k + CONTEXT));
    // The neighbourhood can match when only the lengths differ.
    expect(got.length, `${where}: length`).toBe(want.length);
  }
}

/** agree checks every variant against RecordScanner on one file and cutting. */
function agree(
  bytes: Uint8Array,
  comma: string,
  cutting: Cutting,
  label: string,
): void {
  const want = trace(baseline, bytes, comma, cutting);
  for (const variant of others) {
    const got = trace(variant, bytes, comma, cutting);
    const where = `${variant.name}, ${label}, chunk ${cutting.chunk}, shift ${cutting.shift}, fresh ${cutting.fresh}`;
    same(got.begins, want.begins, (a, b) => a === b, `${where}: begins`);
    same(got.states, want.states, sameState, `${where}: states`);
  }
}

/** sameState compares a state and its CR offset. */
function sameState(
  a: Trace['states'][number],
  b: Trace['states'][number],
): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// Every byte any variant acts on, separators included, multi-byte letters,
// a U+FEFF that can land anywhere, and a run long enough to fill words and
// vectors.
const ALPHABET = [
  'a',
  'b',
  ',',
  ';',
  '\t',
  '"',
  '"',
  '\n',
  '\n',
  '\r',
  '\r\n',
  ' ',
  'é',
  '日',
  '﻿',
  'abcdefghijklmnopqrstuvwxyz0123456789',
];
const SEPARATORS = [',', ';', '\t'];
const BOM_CHANCE = 0.1;

/** csvish is a random file of up to `maxTokens` pieces of the alphabet. */
function csvish(rand: () => number, maxTokens: number): string {
  let s = rand() < BOM_CHANCE ? '﻿' : '';
  const n = Math.floor(rand() * maxTokens);
  for (let i = 0; i < n; i++)
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** Alignments a file may start at within a 32-bit word. */
const SHIFTS = [0, 1, 2, 3];
const SHORT_FILES = 4000;
const SHORT_TOKENS = 40;
const LONG_FILES = 400;
const LONG_TOKENS = 600;
/** The whole file in one push. */
const WHOLE = Number.MAX_SAFE_INTEGER;
/** Chunk sizes for short random files. */
const RANDOM_CHUNKS = [1, 2, 7, 64, 1000, WHOLE];
/**
 * Chunk sizes for long random files, each long enough to hold a word or a
 * vector, so every alignment of head, words and tail comes up. One byte at
 * a time is checked once per file, at one alignment.
 */
const LONG_CHUNKS = [13, 64, 1000, WHOLE];
const LONG_TIMEOUT_MS = 120_000;

describe('every variant matches RecordScanner', () => {
  test(
    'on short random files, in any chunk size and alignment',
    () => {
      for (let seed = 1; seed <= SHORT_FILES; seed++) {
        const rand = random(seed);
        const text = csvish(rand, SHORT_TOKENS);
        const comma = SEPARATORS[Math.floor(rand() * SEPARATORS.length)]!;
        const bytes = encoder.encode(text);
        const shift = SHIFTS[seed % SHIFTS.length]!;
        for (const chunk of RANDOM_CHUNKS) {
          agree(
            bytes,
            comma,
            { chunk, shift, fresh: false },
            `seed ${seed} ${JSON.stringify(text)}`,
          );
        }
      }
    },
    LONG_TIMEOUT_MS,
  );

  test(
    'on long random files, with chunks sliced or copied',
    () => {
      for (let seed = 1; seed <= LONG_FILES; seed++) {
        const rand = random(seed + SHORT_FILES);
        const text = csvish(rand, LONG_TOKENS);
        const comma = SEPARATORS[Math.floor(rand() * SEPARATORS.length)]!;
        const bytes = encoder.encode(text);
        const label = `long seed ${seed}`;
        agree(bytes, comma, { chunk: 1, shift: 0, fresh: false }, label);
        for (const shift of SHIFTS) {
          for (const chunk of LONG_CHUNKS) {
            for (const fresh of [false, true]) {
              agree(bytes, comma, { chunk, shift, fresh }, label);
            }
          }
        }
      }
    },
    LONG_TIMEOUT_MS,
  );

  // The named cases of tests/ingest/scan.test.ts, with their begins.
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
      '﻿"a,b"\nc\n',
      [3, 9],
    ],
  ];

  for (const [name, text, want] of cases) {
    test(name, () => {
      const bytes = encoder.encode(text);
      for (const variant of VARIANTS) {
        for (const chunk of [1, bytes.length]) {
          const got = trace(variant, bytes, ',', {
            chunk,
            shift: 0,
            fresh: false,
          });
          expect(got.begins, `${variant.name}, chunk ${chunk}`).toEqual(want);
        }
      }
      for (const chunk of [1, 2, bytes.length]) {
        agree(bytes, ',', { chunk, shift: 0, fresh: false }, name);
      }
    });
  }

  /** Each shape at this size: several 256 KB wasm pieces and many words. */
  const SHAPE_BYTES = 2 << 20;
  /** The engine's chunk size, which covers the whole file here. */
  const ENGINE_CHUNK = 8 << 20;
  /** Odd sizes, so chunks start at every alignment. */
  const SHAPE_CHUNKS = [4093, 65539, 1 << 20, ENGINE_CHUNK];
  /** Tiny chunks run over this much of each shape. */
  const TINY_PREFIX = 64 << 10;
  const TINY_CHUNK = 7;

  for (const shape of SHAPES) {
    test(
      `on the ${shape.name} shape`,
      () => {
        const bytes = shape.build(SHAPE_BYTES);
        for (const chunk of SHAPE_CHUNKS) {
          for (const fresh of [false, true]) {
            agree(
              bytes,
              shape.comma,
              { chunk, shift: chunk % SHIFTS.length, fresh },
              shape.name,
            );
          }
        }
        const prefix = bytes.subarray(0, TINY_PREFIX);
        for (const shift of SHIFTS) {
          agree(
            prefix,
            shape.comma,
            { chunk: TINY_CHUNK, shift, fresh: false },
            shape.name,
          );
        }
      },
      LONG_TIMEOUT_MS,
    );
  }
});

test('every variant refuses a separator it cannot scan for', () => {
  for (const variant of VARIANTS) {
    for (const comma of ['"', '\n', '\r', 'é', ',,']) {
      expect(() => variant.make(comma, collecting([])), variant.name).toThrow(
        'cannot separate fields',
      );
    }
  }
});

/** Random files of begins for the index check, and their limits. */
const INDEX_FILES = 500;
const MAX_RECORDS = 3000;
const MAX_GAP = 300;
const MAX_BLOCK_ROWS = 50;
const MAX_BLOCK_BYTES = 5000;
const MAX_RUN = 200;
/** Entries past `count` in a run's array, which beginMany must not read. */
const SLACK = 5;
/** What fills them: a begin far below any real one. */
const GARBAGE = -1e9;

/** blocksOf lists each block of a RowIndex as [first row, first byte]. */
function blocksOf(index: RowIndex): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let b = 0; b < index['blocks']; b++) {
    out.push([index.rowsOf(b)[0], index.bytesOf(b)[0]]);
  }
  return out;
}

test('BulkIndex builds the blocks RowIndex builds, fed begins in any runs', () => {
  for (let seed = 1; seed <= INDEX_FILES; seed++) {
    const rand = random(seed);
    const tuning = {
      blockRows: 1 + Math.floor(rand() * MAX_BLOCK_ROWS),
      blockBytes: 1 + Math.floor(rand() * MAX_BLOCK_BYTES),
    };
    const offsets: number[] = [];
    let at = Math.floor(rand() * MAX_GAP);
    for (let n = Math.floor(rand() * MAX_RECORDS); n > 0; n--) {
      offsets.push(at);
      at += 2 + Math.floor(rand() * MAX_GAP);
    }

    const want = new RowIndex(0, at, tuning);
    for (const offset of offsets) want.begin(offset);

    // Runs of random length: single begins, absolute Float64Array runs, and
    // Int32Array runs relative to a base, as the wasm variants hand over.
    const got = new BulkIndex(tuning);
    for (let k = 0; k < offsets.length;) {
      const count = Math.min(
        offsets.length - k,
        1 + Math.floor(rand() * MAX_RUN),
      );
      const run = offsets.slice(k, k + count);
      const kind = Math.floor(rand() * 3);
      if (kind === 0) {
        got.begin(run[0]!);
        k++;
        continue;
      }
      const base = kind === 1 ? 0 : run[0]! - 1;
      const begins =
        kind === 1
          ? new Float64Array(count + SLACK)
          : new Int32Array(count + SLACK);
      begins.fill(GARBAGE);
      begins.set(run.map((offset) => offset - base));
      got.beginMany(begins, count, base);
      k += count;
    }

    const gotBlocks: Array<[number, number]> = [];
    for (let b = 0; b < got.blocks; b++)
      gotBlocks.push([got.firstRow(b), got.firstByte(b)]);
    expect(got.counted, `seed ${seed}`).toBe(want.counted);
    expect(gotBlocks, `seed ${seed}`).toEqual(blocksOf(want));
  }
});
