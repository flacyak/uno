/**
 * @fileoverview Reads back from a gzip inflater: random reads against the
 * whole file inflated, over every kind of checkpoint a read resumes from.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, test } from 'vite-plus/test';

import {
  ALONE,
  INFLATE_SLICE_BYTES,
  gunzipWhole,
  gzipInflater,
  partBudget,
} from '@ingest/gzip';
import type { Inflater, InflaterBudget } from '@ingest/gzip';
import { bytesSource } from '@store';
import { concat, differAt, fixture, kind } from './bytes.ts';

/** Rows of text on each side of the noise. */
const ROWS = 480_000;
/** Names a row picks from, so the text compresses as text does. */
const NAMES = 997;
/** Cents in a unit, for a row's amount. */
const CENTS = 100;
/** Noise between the rows, which deflate keeps in stored blocks. */
const NOISE_BYTES = 2 << 20;
/** A span the file passes many times over, so it holds many checkpoints. */
const SPAN = 256 << 10;
/** Random reads made, and the most bytes one asks for. */
const READS = 200;
const MOST_READ = 64 << 10;
/** Parts read as one, enough that the windows thin and the span doubles. */
const PARTS = 64;
/** The values a uint32 takes. */
const UINT32_VALUES = 2 ** 32;
const BUDGETS: [string, InflaterBudget][] = [
  ['alone', ALONE],
  ['as one of many parts', partBudget(PARTS)],
];

/** Bytes that look random, the same on every run for a seed. */
function noise(seed: string, length: number): Uint8Array {
  const hash = createHash('shake256', { outputLength: length });
  return new Uint8Array(hash.update(seed).digest());
}

/** Numbers in [0, 1) that look random, the same on every run for a seed. */
function fractions(seed: string, count: number): number[] {
  const bytes = noise(seed, count * Uint32Array.BYTES_PER_ELEMENT);
  return [...new Uint32Array(bytes.buffer)].map((n) => n / UINT32_VALUES);
}

/** Rows of text numbered from `first`, no two alike. */
function rows(first: number, count: number): Uint8Array {
  const lines: string[] = [];
  for (let n = first; n < first + count; n++) {
    lines.push(`${n},name ${n % NAMES},${(n / CENTS).toFixed(2)}\n`);
  }
  return new TextEncoder().encode(lines.join(''));
}

/**
 * About 24 MB of rows around noise, as one member, then the members and BGZF
 * fixtures. The noise is in stored blocks, and the rows' blocks start part
 * way into a byte.
 */
const stored = concat([
  gzipSync(
    concat([rows(0, ROWS), noise('noise', NOISE_BYTES), rows(ROWS, ROWS)]),
  ),
  fixture('gzip/members.csv.gz'),
  fixture('gzip/bgzf.csv.gz'),
]);
const whole = gunzipWhole(stored);

/** An inflater that has passed the whole file. */
function passed(budget: InflaterBudget): Inflater {
  const inflater = gzipInflater(bytesSource(stored), budget, SPAN);
  for (let at = 0; at < stored.length; at += INFLATE_SLICE_BYTES) {
    inflater.push(stored.subarray(at, at + INFLATE_SLICE_BYTES), () => {});
  }
  inflater.end();
  return inflater;
}

/** Expects the read of `length` bytes at `offset` to be the file's. */
async function expectRead(
  inflater: Inflater,
  offset: number,
  length: number,
): Promise<void> {
  const read = await inflater.read(offset, length);
  const want = whole.subarray(offset, offset + length);
  expect(differAt(read, want), `the read of ${length} at ${offset}`).toBe(-1);
}

describe('a gzip read', () => {
  test('resumes from checkpoints of every kind, past the first', () => {
    const [, ...points] = passed(ALONE).checkpoints();
    expect(new Set(points.map(kind))).toEqual(
      new Set(['a member start', 'a byte', 'even bits', 'odd bits']),
    );
  });

  test.each(BUDGETS)(
    '%s, at random, is what the whole file holds there',
    async (_, budget) => {
      const inflater = passed(budget);
      const points = inflater.checkpoints();
      const wheres = fractions('where', READS);
      const sizes = fractions('size', READS);
      for (let i = 0; i < READS; i++) {
        const where = wheres[i]!;
        const length = Math.floor(sizes[i]! * MOST_READ);
        // Every other read straddles a checkpoint, a member start among them.
        const point = points[Math.floor(where * points.length)]!;
        const offset =
          i % 2 === 0
            ? Math.floor(where * whole.length)
            : Math.max(0, point.decoded - Math.floor(length / 2));
        await expectRead(inflater, offset, length);
      }
    },
  );

  test('gives fewer bytes only at the end of the stream', async () => {
    const TAIL = 10;
    const inflater = passed(ALONE);
    await expectRead(inflater, whole.length - TAIL, MOST_READ);
    expect(await inflater.read(whole.length - TAIL, MOST_READ)).toHaveLength(
      TAIL,
    );
    expect(await inflater.read(whole.length, MOST_READ)).toHaveLength(0);
  });

  test('during the pass, of bytes it has passed', async () => {
    const inflater = gzipInflater(bytesSource(stored), ALONE, SPAN);
    let reached = 0;
    for (let at = 0; at < stored.length; at += INFLATE_SLICE_BYTES) {
      const slice = stored.subarray(at, at + INFLATE_SLICE_BYTES);
      inflater.push(slice, (piece, offset) => {
        reached = offset + piece.length;
      });
      await expectRead(inflater, Math.floor(reached / 2), MOST_READ);
    }
  });
});
