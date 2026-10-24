/**
 * @fileoverview A skeptic's checks of the scanner lab: the two wasm kernels
 * and BulkIndex.beginMany against RecordScanner and RowIndex, on the cases
 * scanner.test.ts does not reach.
 *
 * scanner.test.ts never splits one push into two 256 KB wasm pieces with
 * anything but its six regular shapes, none of which has a CR that starts a
 * record, and it fills the slack past a run with a value below every begin.
 * These tests put every short byte string across a 16 and 64 byte boundary
 * in three states, across a piece boundary inside one push, fill the piece
 * with poison before each scan, feed BulkIndex garbage above every begin,
 * and build whole indexes end to end through both paths.
 */

import { describe, expect, test } from 'vite-plus/test';

import { RowIndex, TUNING } from '@engine/rows';
import type { Tuning } from '@engine/rows';
import { BaselineScanner } from '../../scanner/baseline.ts';
import { BulkIndex } from '../../scanner/bulk.ts';
import type {
  Begins,
  Consumer,
  LabScanner,
  State,
} from '../../scanner/common.ts';
import { SHAPES, random } from '../../scanner/shapes.ts';
import { WasmScanner } from '../../scanner/wasm.ts';
import type { Handoff, KernelName } from '../../scanner/wasm.ts';
import { RecordBulkScanner } from './recordbulk.ts';

const encoder = new TextEncoder();

/** The piece scan.c scans per call, PIECE_BYTES there. */
const PIECE = 256 * 1024;
const KERNELS: readonly KernelName[] = ['vectors', 'blocks'];
const HANDOFFS: readonly Handoff[] = ['each', 'many'];

/** What one scan reports: every begin and the state after the last push. */
interface Outcome {
  readonly begins: number[];
  readonly state: State;
  readonly crAt: number | undefined;
}

function collecting(out: number[]): Consumer {
  return {
    begin: (offset) => out.push(offset),
    many: (begins, count, base) => {
      for (let k = 0; k < count; k++) out.push(base + begins[k]!);
    },
  };
}

/** run pushes `file` through `make`'s scanner, cut at the given lengths. */
function run(
  make: (consumer: Consumer) => LabScanner,
  file: Uint8Array,
  cuts: readonly number[],
  base = 0,
): Outcome {
  const begins: number[] = [];
  const scanner = make(collecting(begins));
  let at = 0;
  let k = 0;
  while (at < file.length) {
    const length = Math.min(cuts[k % cuts.length]!, file.length - at);
    scanner.push(file.subarray(at, at + length), base + at);
    at += length;
    k++;
  }
  const state = scanner.state;
  return { begins, state, crAt: state === 1 ? scanner.crAt : undefined };
}

const reference = (comma: string) => (c: Consumer) =>
  new BaselineScanner(comma, c.begin);

/** Every wasm variant, and the JS RecordScanner-with-runs variant. */
const CANDIDATES: ReadonlyArray<
  [string, (comma: string) => (c: Consumer) => LabScanner]
> = [
  ...KERNELS.flatMap((kernel) =>
    HANDOFFS.map(
      (handoff): [string, (comma: string) => (c: Consumer) => LabScanner] => [
        `wasm ${kernel} ${handoff}`,
        (comma) => (c) => new WasmScanner(comma, c, kernel, handoff),
      ],
    ),
  ),
  ['record-bulk', (comma) => (c) => new RecordBulkScanner(comma, c.many)],
];

/**
 * poison fills every byte of the shared wasm piece with `byte`, by scanning
 * a piece's worth of it. Whatever a later short scan leaves past its end is
 * then that byte.
 */
function poison(byte: number): void {
  const fill = new Uint8Array(PIECE).fill(byte);
  new WasmScanner(',', collecting([]), 'vectors', 'many').push(fill, 0);
}

/** firstDifference is the first index where two outcomes differ, or -1. */
function firstDifference(got: Outcome, want: Outcome): number {
  const n = Math.max(got.begins.length, want.begins.length);
  for (let k = 0; k < n; k++) {
    if (got.begins[k] !== want.begins[k]) return k;
  }
  if (got.state !== want.state || got.crAt !== want.crAt) return n;
  return -1;
}

/** check compares every candidate with RecordScanner on one file and cutting. */
function check(
  file: Uint8Array,
  comma: string,
  cuts: readonly number[],
  label: string,
  base = 0,
): string | undefined {
  const want = run(reference(comma), file, cuts, base);
  for (const [name, make] of CANDIDATES) {
    const got = run(make(comma), file, cuts, base);
    const k = firstDifference(got, want);
    if (k >= 0) {
      return (
        `${name}, ${label}, cuts ${cuts.join('/')}, at begin ${k}: ` +
        `got ${JSON.stringify(got.begins.slice(Math.max(0, k - 2), k + 3))} ` +
        `state ${got.state}/${got.crAt}, want ` +
        `${JSON.stringify(want.begins.slice(Math.max(0, k - 2), k + 3))} ` +
        `state ${want.state}/${want.crAt}`
      );
    }
  }
  return undefined;
}

/** The bytes that change the scanner's state, and one that does not. */
const SYMBOLS = ['a', ',', '"', '\n', '\r'];

/** every lists every string over SYMBOLS of length 1 to `max`. */
function every(max: number): string[] {
  const out: string[] = [];
  let level = [''];
  for (let n = 1; n <= max; n++) {
    level = level.flatMap((s) => SYMBOLS.map((c) => s + c));
    out.push(...level);
  }
  return out;
}

/** Text ending in each state the boundary can be crossed in. */
function context(kind: 'line' | 'bare' | 'quoted', length: number): string {
  if (length === 0) return '';
  if (kind === 'line') return `${'x'.repeat(length - 1)}\n`;
  if (kind === 'bare') return 'x'.repeat(length);
  return `"${'x'.repeat(length - 1)}`;
}

const CONTEXTS = ['line', 'bare', 'quoted'] as const;
const LONG_TIMEOUT_MS = 600_000;

describe('the wasm kernels match RecordScanner', () => {
  test(
    'on every string of up to 6 state bytes across a 16 and 64 byte boundary',
    () => {
      const strings = every(6);
      // Starts at, just before and just after the first vector and block
      // boundaries.
      const offsets = [0, 1, 14, 15, 16, 59, 61, 62, 63, 64, 65];
      const tails = ['', 'zz\nzz', `${'y'.repeat(70)}\n`];
      const failures: string[] = [];
      let k = 0;
      for (const s of strings) {
        for (const at of offsets) {
          for (const kind of CONTEXTS) {
            const tail = tails[k++ % tails.length]!;
            const file = encoder.encode(context(kind, at) + s + tail);
            if (k % 97 === 0) poison(k % 2 === 0 ? 0x0a : 0x22);
            const failure = check(file, ',', [file.length], JSON.stringify(s));
            if (failure !== undefined) failures.push(failure);
            if (failures.length > 5) break;
          }
        }
      }
      expect(failures).toEqual([]);
    },
    LONG_TIMEOUT_MS,
  );

  test(
    'on every string of up to 3 state bytes across a piece boundary inside one push',
    () => {
      const failures: string[] = [];
      for (const s of every(3)) {
        for (let back = 0; back <= s.length; back++) {
          for (const kind of CONTEXTS) {
            const file = encoder.encode(
              `${context(kind, PIECE - back)}${s}b,c\n`,
            );
            const failure = check(
              file,
              ',',
              [file.length],
              `${kind} ${JSON.stringify(s)} back ${back}`,
            );
            if (failure !== undefined) failures.push(failure);
          }
        }
      }
      expect(failures).toEqual([]);
    },
    LONG_TIMEOUT_MS,
  );

  test('when a CR that begins a record is the last byte of a piece', () => {
    // LINE at the CR, so the record is reported from the next piece at -1.
    for (const after of ['a\n', ',\n', '"x\n', '\n', '\r\n', '\ra\n']) {
      const text = `${'x'.repeat(PIECE - 2)}\n\r${after}tail\n`;
      const file = encoder.encode(text);
      for (const cuts of [[file.length], [PIECE], [PIECE - 1], [PIECE + 1]]) {
        expect(check(file, ',', cuts, JSON.stringify(after))).toBeUndefined();
      }
    }
  });

  test(
    'on dense random files of several pieces, poisoned, cut anywhere, past 4 GB',
    () => {
      // Heavy in every state byte, so all seven states meet piece, chunk,
      // vector and block boundaries.
      const alphabet = ['a', ',', ';', '\t', '"', '"', '\n', '\r', '\r\n', 'é'];
      const FILE_BYTES = 3 * PIECE + 777;
      const FILES = 24;
      const BEYOND_4GB = 2 ** 32 + 12345;
      const failures: string[] = [];
      for (let seed = 1; seed <= FILES; seed++) {
        const rand = random(seed * 7919);
        const parts: string[] = [];
        let n = 0;
        while (n < FILE_BYTES) {
          const p = alphabet[Math.floor(rand() * alphabet.length)]!;
          parts.push(p);
          n += p.length;
        }
        const file = encoder.encode(parts.join(''));
        const comma = [',', ';', '\t'][seed % 3]!;
        const cutsList = [
          [file.length],
          [8 << 20],
          [PIECE - 1],
          [PIECE + 1],
          [63, 65, 4093],
          [1 + Math.floor(rand() * 200000)],
        ];
        poison([0x0a, 0x22, 0x0d][seed % 3]!);
        for (const cuts of cutsList) {
          const base = seed % 2 === 0 ? BEYOND_4GB : 0;
          const failure = check(file, comma, cuts, `seed ${seed}`, base);
          if (failure !== undefined) failures.push(failure);
        }
        // Unaligned views: the same bytes one to three bytes into a buffer.
        const shifted = new Uint8Array(file.length + 3);
        shifted.set(file, seed % 4);
        const view = shifted.subarray(seed % 4, (seed % 4) + file.length);
        const failure = check(view, comma, [4093], `seed ${seed} shifted`);
        if (failure !== undefined) failures.push(failure);
      }
      expect(failures).toEqual([]);
    },
    LONG_TIMEOUT_MS,
  );
});

/** blocksOf lists each block of an index as [first row, first byte]. */
function rowBlocks(index: RowIndex): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let b = 0; b < index['blocks']; b++) {
    out.push([index.rowsOf(b)[0], index.bytesOf(b)[0]]);
  }
  return out;
}

function bulkBlocks(index: BulkIndex): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let b = 0; b < index.blocks; b++) {
    out.push([index.firstRow(b), index.firstByte(b)]);
  }
  return out;
}

type Limits = Pick<Tuning, 'blockRows' | 'blockBytes'>;

/** perRecord builds a RowIndex from absolute offsets, one begin at a time. */
function perRecord(offsets: readonly number[], limits: Limits): RowIndex {
  const index = new RowIndex(0, Number.MAX_SAFE_INTEGER, limits);
  for (const offset of offsets) index.begin(offset);
  return index;
}

/** inRuns feeds BulkIndex the offsets in the runs given, with garbage after. */
function inRuns(
  offsets: readonly number[],
  limits: Limits,
  runs: ReadonlyArray<{ count: number; base: number; int32: boolean }>,
  garbage: number,
): BulkIndex {
  const index = new BulkIndex(limits);
  let k = 0;
  for (const { count, base, int32 } of runs) {
    const begins: Begins = int32
      ? new Int32Array(count + 8)
      : new Float64Array(count + 8);
    begins.fill(garbage);
    for (let j = 0; j < count; j++) begins[j] = offsets[k + j]! - base;
    index.beginMany(begins, count, base);
    k += count;
  }
  expect(k).toBe(offsets.length);
  return index;
}

describe('BulkIndex.beginMany matches RowIndex.begin', () => {
  test('with garbage above every begin, NaN, and empty runs', () => {
    const limits = { blockRows: 4, blockBytes: 10 };
    const offsets = Array.from({ length: 40 }, (_, i) => i * 3);
    const want = rowBlocks(perRecord(offsets, limits));
    for (const garbage of [1e15, Number.NaN, -1e9, Infinity]) {
      const runs = [
        { count: 0, base: 0, int32: false },
        { count: 5, base: 0, int32: false },
        { count: 0, base: 0, int32: false },
        { count: 7, base: 14, int32: false },
        { count: 28, base: 35, int32: false },
      ];
      const got = inRuns(offsets, limits, runs, garbage);
      expect(bulkBlocks(got), `garbage ${garbage}`).toEqual(want);
      expect(got.counted).toBe(offsets.length);
    }
    // Int32 garbage is clamped, so test its largest value too.
    const runs = [
      { count: 13, base: 0, int32: true },
      { count: 27, base: 38, int32: true },
    ];
    expect(bulkBlocks(inRuns(offsets, limits, runs, 2 ** 31 - 1))).toEqual(
      want,
    );
  });

  test('when a run starts exactly where a block must open', () => {
    // Rows: the 5th record opens a block, and a run starts on it. Bytes: a
    // begin exactly blockBytes past the block start opens one.
    const limits = { blockRows: 4, blockBytes: 12 };
    const offsets = [0, 2, 4, 6, 8, 12, 24, 25, 36, 48, 60, 61, 62, 63];
    const want = rowBlocks(perRecord(offsets, limits));
    for (let split = 0; split <= offsets.length; split++) {
      const runs = [
        { count: split, base: 0, int32: false },
        {
          count: offsets.length - split,
          base: offsets[split] ?? 0,
          int32: true,
        },
      ];
      expect(
        bulkBlocks(inRuns(offsets, limits, runs, 1e15)),
        `split ${split}`,
      ).toEqual(want);
    }
  });

  test('with a record begun at -1 from its base, as wasm reports a CR', () => {
    const limits = { blockRows: 3, blockBytes: 1 << 20 };
    const offsets = [0, 4, 9, 99, 102, 105];
    const want = rowBlocks(perRecord(offsets, limits));
    const runs = [
      { count: 3, base: 0, int32: true },
      { count: 3, base: 100, int32: true },
    ];
    expect(bulkBlocks(inRuns(offsets, limits, runs, 7))).toEqual(want);
  });

  test('on random begins one byte apart and up, blockRows and blockBytes from 1', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = random(seed + 99991);
      const limits = {
        blockRows: 1 + Math.floor(rand() * rand() * 40),
        blockBytes: 1 + Math.floor(rand() * rand() * 3000),
      };
      const offsets: number[] = [];
      let at = 2 ** 33 + Math.floor(rand() * 100);
      for (let n = Math.floor(rand() * 2000); n > 0; n--) {
        offsets.push(at);
        at += 1 + Math.floor(rand() * rand() * 200);
      }
      const runs: Array<{ count: number; base: number; int32: boolean }> = [];
      for (let k = 0; k < offsets.length;) {
        const count = Math.min(
          offsets.length - k,
          Math.floor(rand() * rand() * 300),
        );
        // Base at, before or one past the run's first begin.
        const first = offsets[k] ?? 0;
        const base = first - Math.floor(rand() * 3) + 1;
        runs.push({ count, base, int32: rand() < 0.5 });
        k += count;
      }
      const want = perRecord(offsets, limits);
      const got = inRuns(offsets, limits, runs, rand() < 0.5 ? 1e15 : -1e15);
      expect(got.counted, `seed ${seed}`).toBe(want.counted);
      expect(bulkBlocks(got), `seed ${seed}`).toEqual(rowBlocks(want));
    }
  });
});

/** Tunings that put block ends on, near and far from piece ends. */
const LIMITS: readonly Limits[] = [
  TUNING,
  { blockRows: 7, blockBytes: 300 },
  { blockRows: 1024, blockBytes: 4096 },
  { blockRows: 100_000, blockBytes: PIECE },
];

describe('the index built through runs is the index built per record', () => {
  for (const shape of SHAPES) {
    test(
      `on the ${shape.name} shape, in the engine's chunks`,
      () => {
        const file = shape.build(6 << 20);
        for (const limits of LIMITS) {
          const want = new RowIndex(0, file.length, limits);
          run(reference(shape.comma), file, [TUNING.chunkBytes]).begins.forEach(
            (o) => want.begin(o),
          );
          for (const kernel of KERNELS) {
            const bulk = new BulkIndex(limits);
            const scanner = new WasmScanner(
              shape.comma,
              {
                begin: (o) => bulk.begin(o),
                many: (b, c, base) => bulk.beginMany(b, c, base),
              },
              kernel,
              'many',
            );
            for (let at = 0; at < file.length; at += TUNING.chunkBytes) {
              scanner.push(
                file.subarray(
                  at,
                  Math.min(at + TUNING.chunkBytes, file.length),
                ),
                at,
              );
            }
            const where = `${kernel}, ${JSON.stringify(limits)}`;
            expect(bulk.counted, where).toBe(want.counted);
            expect(bulkBlocks(bulk), where).toEqual(rowBlocks(want));
          }
        }
      },
      LONG_TIMEOUT_MS,
    );
  }
});
