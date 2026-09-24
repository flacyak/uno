/**
 * @fileoverview A skeptic's check of core/tests/lab/parallel/speculate.ts:
 * every start state's trace through a chunk scan, against RecordScanner
 * started in that same state, over input heavy in runs of quotes and CRs,
 * with separators beyond `,` and `;`, multi-byte characters at chunk edges,
 * a fresh random length for every chunk, and offsets past 2^31 and 2^32.
 */

import { describe, expect, test, vi } from 'vite-plus/test';

import { RecordScanner } from '@ingest/scan';
import {
  LINE,
  LINE_CR,
  STATES,
  scanChunk,
  separatorOf,
  trace,
} from '../../parallel/speculate.ts';
import type { ChunkScan, State } from '../../parallel/speculate.ts';
import { SEPARATORS, gnarly, random, randomLengths } from './gen.ts';

const encoder = new TextEncoder();

/** The private fields of RecordScanner this test reads and sets. */
interface ScannerInside {
  state: number;
  crAt: number;
}

function inside(scanner: RecordScanner): ScannerInside {
  return scanner as unknown as ScannerInside;
}

/** What RecordScanner reports for one chunk from a given state. */
interface Truth {
  begins: number[];
  end: number;
}

/**
 * truthFrom pushes `chunk` at `base` into a RecordScanner set to `state`,
 * with crAt on the byte before the chunk as LINE_CR requires.
 */
function truthFrom(
  chunk: Uint8Array,
  base: number,
  comma: string,
  state: State,
): Truth {
  const begins: number[] = [];
  const scanner = new RecordScanner(comma, (offset) => begins.push(offset));
  inside(scanner).state = state;
  inside(scanner).crAt = base - 1;
  scanner.push(chunk, base);
  return { begins, end: inside(scanner).state };
}

/** traced lists the begins trace names for `start`, in order. */
function traced(scan: ChunkScan, start: State): number[] {
  const out: number[] = [];
  for (const [from, to] of trace(scan, start).ranges) {
    for (let k = from; k < to; k++) out.push(scan.begins[k]!);
  }
  return out;
}

/** expectEveryStart checks all seven start states of one chunk. */
function expectEveryStart(
  chunk: Uint8Array,
  base: number,
  comma: string,
  label: string,
): void {
  const scan = scanChunk(chunk, base, separatorOf(comma));
  expect(scan.base, label).toBe(base);
  expect(scan.length, label).toBe(chunk.length);
  for (const start of STATES) {
    const want = truthFrom(chunk, base, comma, start);
    expect(traced(scan, start), `${label} from ${start}`).toEqual(want.begins);
    expect(trace(scan, start).end, `${label} from ${start}`).toBe(want.end);
  }
}

const SEEDS = 4000;
const MAX_TOKENS = 60;
/**
 * How long a sweep over SEEDS random texts may take. The two sweeps run in
 * about 2.5 s and 1.5 s alone, and the first took over 5 s under the full
 * parallel run, so the default 5 s failed the file now and then. The budget
 * sits well above both, and is the file's, since the second sweep's header
 * does not fit the line with an options object.
 */
const SWEEP_MS = 30_000;
vi.setConfig({ testTimeout: SWEEP_MS });

describe('every start state of a chunk scan matches RecordScanner', () => {
  test('on gnarly chunks, with every separator', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed);
      const comma = SEPARATORS[seed % SEPARATORS.length]!;
      const text = gnarly(rand, Math.floor(rand() * MAX_TOKENS));
      const bytes = encoder.encode(text);
      // The whole text as one chunk, and each prefix and suffix too.
      expectEveryStart(bytes, 0, comma, `seed ${seed} whole`);
      const cut = Math.floor(rand() * (bytes.length + 1));
      expectEveryStart(bytes.subarray(0, cut), 0, comma, `seed ${seed} head`);
      expectEveryStart(bytes.subarray(cut), cut, comma, `seed ${seed} tail`);
    }
  });

  // Each offset sits past a power of two that a 32-bit operation would wrap.
  const FAR = [2 ** 31 - 3, 2 ** 31, 2 ** 32 - 1, 2 ** 32 + 7, 2 ** 40 + 1];
  test('at offsets past 2^31 and 2^32', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = random(seed);
      const comma = SEPARATORS[seed % SEPARATORS.length]!;
      const bytes = encoder.encode(gnarly(rand, 30));
      for (const base of FAR) {
        expectEveryStart(bytes, base, comma, `seed ${seed} at ${base}`);
      }
    }
  });
});

describe('stitched in file order, a fresh length for every chunk', () => {
  test('begins, the state at every edge and crAt agree', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed + 1_000_000);
      const comma = SEPARATORS[seed % SEPARATORS.length]!;
      const sep = separatorOf(comma);
      const bytes = encoder.encode(gnarly(rand, Math.floor(rand() * 80)));
      const base = rand() < 0.2 ? 2 ** 32 - 5 : 0;
      const label = `seed ${seed}`;

      const want: number[] = [];
      const scanner = new RecordScanner(comma, (offset) => want.push(offset));
      const got: number[] = [];
      let state: State = LINE;
      let at = 0;
      for (const length of randomLengths(rand, bytes.length)) {
        const chunk = bytes.subarray(at, at + length);
        scanner.push(chunk, base + at);
        const scan = scanChunk(chunk, base + at, sep);
        got.push(...traced(scan, state));
        state = trace(scan, state).end;
        at += length;
        expect(state, `${label} at ${at}`).toBe(inside(scanner).state);
        // In LINE_CR the CR is the byte just read, which is what
        // speculate.ts reports for a begin at the next chunk's start.
        if (state === LINE_CR) {
          expect(inside(scanner).crAt, `${label} crAt`).toBe(base + at - 1);
        }
      }
      expect(got, label).toEqual(want);
    }
  });
});
