/**
 * @fileoverview Checks that the parallel lab's `difference` compares every
 * field a RowIndex stores, by reading the private arrays as well.
 *
 * - On real data both ways, the private arrays match whenever `difference`
 *   finds nothing.
 * - Changing any one stored entry, the last block's included, makes
 *   `difference` report it.
 */

import { describe, expect, test } from 'vite-plus/test';

import { RowIndex, TUNING, indexPass } from '@engine';
import type { Tuning } from '@engine';
import { peekFormat } from '@ingest';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { repeated } from '@core-tests/testdata/sales-q3';
import {
  contextFor,
  difference,
  parallelIndex,
  sequentialIndex,
} from '../../parallel/indexes.ts';
import { inlineScanner, planFor } from '../../parallel/pass.ts';
import { ScanPool } from '../../parallel/pool.ts';
import { ALTERNATING, PLAIN, SYNTHETIC } from '../../parallel/shapes.ts';
import type { StitchMode } from '../../parallel/stitch.ts';

/** Stored is everything a RowIndex keeps, private fields included. */
interface Stored {
  start: number;
  size: number;
  counted: number;
  scanned: number;
  complete: boolean;
  blocks: number;
  firsts: number[];
  offsets: number[];
}

function field(index: RowIndex, name: string): unknown {
  return Reflect.get(index, name);
}

function arrayField(index: RowIndex, name: string): Float64Array {
  const value = field(index, name);
  if (!(value instanceof Float64Array)) throw new Error(`${name} moved`);
  return value;
}

/** stored reads a RowIndex's whole state, up to its block count. */
function stored(index: RowIndex): Stored {
  const blocks = field(index, 'blocks');
  if (typeof blocks !== 'number') throw new Error('blocks moved');
  return {
    start: index.start,
    size: index.size,
    counted: index.counted,
    scanned: index.scanned,
    complete: index.complete,
    blocks,
    firsts: Array.from(arrayField(index, 'firsts').subarray(0, blocks)),
    offsets: Array.from(arrayField(index, 'offsets').subarray(0, blocks)),
  };
}

const STITCHES: readonly StitchMode[] = ['record', 'block'];
const WORKERS = 4;
const READS = 4;
/** 96 MB, the bench's in-memory fixture. */
const REPEATS = 400;
const SHAPE_BYTES = 24 << 20;
/** A chunk size that is not a power of two, so cuts land mid row. */
const ODD_CHUNK = (3 << 20) - 1;

async function bothWays(
  source: ByteSource,
  tuning: Tuning,
  pool: ScanPool,
): Promise<void> {
  const format = await peekFormat('lab.csv', source);
  if (format === undefined) throw new Error('empty');
  const want = await sequentialIndex(source, format, tuning);
  for (const stitch of STITCHES) {
    const got = await parallelIndex(
      source,
      format,
      tuning,
      pool,
      planFor(WORKERS, READS, stitch),
    );
    expect(difference(got, want)).toBeUndefined();
    expect(stored(got)).toEqual(stored(want));
  }
}

describe('difference against the private arrays', () => {
  test('96 MB fixture, shared and copied, and three shapes', async () => {
    const pool = await ScanPool.start(WORKERS);
    try {
      const bytes = repeated(REPEATS);
      await bothWays(bytesSource(bytes), TUNING, pool);
      const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
      shared.set(bytes);
      await bothWays(bytesSource(shared), TUNING, pool);
      for (const shape of [SYNTHETIC, PLAIN, ALTERNATING]) {
        const source = bytesSource(shape.make(SHAPE_BYTES));
        await bothWays(source, { ...TUNING, chunkBytes: ODD_CHUNK }, pool);
      }
    } finally {
      await pool.close();
    }
  }, 240_000);

  test('any one changed stored entry is reported', async () => {
    const source = bytesSource(SYNTHETIC.make(1 << 20));
    const format = await peekFormat('lab.csv', source);
    if (format === undefined) throw new Error('empty');
    const tuning = { ...TUNING, blockRows: 64, blockBytes: 4096 };
    const build = async (): Promise<RowIndex> => {
      const ctx = contextFor(source, format, tuning);
      await indexPass(ctx);
      return ctx.index;
    };
    const want = await build();
    const blocks = stored(want).blocks;
    expect(blocks).toBeGreaterThan(2);
    let reported = 0;
    for (const name of ['firsts', 'offsets']) {
      for (let k = 0; k < blocks; k++) {
        const got = await build();
        const values = arrayField(got, name);
        // A block start one later than it was, kept below the next one.
        values[k] = values[k]! + 1;
        if (difference(got, want) !== undefined) reported++;
      }
    }
    // Block 0's first row moved to 1 is still reported, as row 1 at block 0.
    expect(reported).toBe(2 * blocks);
  });

  test('random input through the inline scanner, in tiny chunks', async () => {
    const encoder = new TextEncoder();
    const alphabet = ['a', ',', '"', '"', '\n', '\r', '\r\n', 'é'];
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const tuning: Tuning = {
      chunkBytes: 3,
      blockRows: 2,
      blockBytes: 8,
      cacheBytes: 0,
    };
    for (let run = 0; run < 500; run++) {
      let text = '';
      const n = Math.floor(rand() * 50);
      for (let i = 0; i < n; i++)
        text += alphabet[Math.floor(rand() * alphabet.length)];
      const source = bytesSource(encoder.encode(text));
      const format = await peekFormat('lab.csv', source);
      if (format === undefined) continue;
      const want = await sequentialIndex(source, format, tuning);
      for (const stitch of STITCHES) {
        const got = await parallelIndex(
          source,
          format,
          tuning,
          inlineScanner,
          planFor(2, 2, stitch),
        );
        expect(stored(got), JSON.stringify(text)).toEqual(stored(want));
      }
    }
  });
});
