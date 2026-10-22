/**
 * @fileoverview Reads back from a gzip inflater: random reads against the
 * whole file inflated, over every kind of checkpoint a read resumes from.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { Deflate, Z_SYNC_FLUSH } from 'pako';
import { describe, expect, test } from 'vite-plus/test';

import {
  ALONE,
  INFLATE_SLICE_BYTES,
  WINDOW_BYTES,
  gunzipWhole,
  gzipInflater,
  partBudget,
} from '@ingest/gzip';
import type {
  Checkpoint,
  Inflater,
  InflaterBudget,
  Stored,
} from '@ingest/gzip';
import { bytesSource } from '@store';
import { fastest } from '@core-tests/performance/time';
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
/** Whole windows in a budget the file fills many times over. */
const THINNED_WINDOWS = 4;
/**
 * Rows flushed one at a time, as a log writer does. Each is a block of its
 * own, and a span of SPAN holds tens of thousands of them.
 */
const FLUSHED_ROWS = 50_000;
/** Timed runs of a read, the quickest kept. */
const SAMPLES = 3;
/** How many times slower keeping a span may make reading in order. */
const SLOWER_AT_MOST = 3;
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

/** A read of the stored bytes: where it started, and where it ended. */
interface StoredRead {
  readonly offset: number;
  readonly end: number;
}

/** The stored bytes as a source that notes every read of it. */
function logged(reads: StoredRead[]): Stored {
  const source = bytesSource(stored);
  return {
    read: async (offset, length) => {
      const bytes = await source.read(offset, length);
      reads.push({ offset, end: offset + bytes.length });
      return bytes;
    },
  };
}

/** An inflater that has passed the whole file, reading back from `source`. */
function passed(
  budget: InflaterBudget,
  source: Stored = bytesSource(stored),
): Inflater {
  const inflater = gzipInflater(source, budget, SPAN);
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

describe('a gzip read carries on from where the last left off', () => {
  test.each(BUDGETS)(
    '%s, so reads in order never resume',
    async (_, budget) => {
      const reads: StoredRead[] = [];
      const inflater = passed(budget, logged(reads));
      for (let offset = 0; offset < whole.length; offset += MOST_READ) {
        await expectRead(inflater, offset, MOST_READ);
      }
      expect(reads[0]!.offset).toBe(inflater.checkpoints()[0]!.stored);
      const starts = reads.slice(1).map(({ offset }) => offset);
      expect(
        starts,
        'each read of the stored bytes where the last ended',
      ).toEqual(reads.slice(0, -1).map(({ end }) => end));
    },
  );

  test('unless a checkpoint is nearer the next read', async () => {
    const reads: StoredRead[] = [];
    const inflater = passed(ALONE, logged(reads));
    const [, near, , far] = inflater.checkpoints();
    await expectRead(inflater, near!.decoded, MOST_READ);
    reads.length = 0;
    await expectRead(inflater, far!.decoded + MOST_READ, MOST_READ);
    expect(reads[0]!.offset).toBe(far!.stored);
  });

  test('once at a time, when reads are made together', async () => {
    const inflater = passed(ALONE);
    await expectRead(inflater, 0, MOST_READ);
    const offsets = [1, 2, 3].map((n) => n * MOST_READ);
    await Promise.all(
      offsets.map((offset) => expectRead(inflater, offset, MOST_READ)),
    );
  });
});

describe('a gzip read back up the file', () => {
  /**
   * Reads to the end of the gap between the first two windowed checkpoints,
   * then the middle of it, and gives the stored reads the second made.
   */
  async function readBack(budget: InflaterBudget): Promise<{
    reads: StoredRead[];
    start: Checkpoint;
  }> {
    const reads: StoredRead[] = [];
    const inflater = passed(budget, logged(reads));
    const [, start, end] = inflater.checkpoints();
    await expectRead(inflater, end!.decoded - MOST_READ, MOST_READ);
    reads.length = 0;
    const middle = Math.floor((start!.decoded + end!.decoded) / 2);
    await expectRead(inflater, middle, MOST_READ);
    return { reads, start: start! };
  }

  test('alone, is from the span it keeps behind its cursor', async () => {
    expect((await readBack(ALONE)).reads).toEqual([]);
  });

  test('as one of many parts, resumes, since a part keeps no span', async () => {
    const { reads, start } = await readBack(partBudget(PARTS));
    expect(reads[0]!.offset).toBe(start.stored);
  });

  test('alone, once its checkpoints thin, keeps the span it began with', async () => {
    const thinned = { ...ALONE, windows: THINNED_WINDOWS * WINDOW_BYTES };
    const { reads, start } = await readBack(thinned);
    expect(reads[0]!.offset).toBe(start.stored);
  });
});

describe('a gzip read in order of a file flushed after every row', () => {
  /** Reads the whole file in order with `budget`, once it has passed it. */
  async function passAndRead(
    flushed: Uint8Array,
    budget: InflaterBudget,
  ): Promise<void> {
    const inflater = gzipInflater(bytesSource(flushed), budget, SPAN);
    inflater.push(flushed, () => {});
    const size = inflater.end();
    for (let offset = 0; offset < size; offset += MOST_READ) {
      await inflater.read(offset, MOST_READ);
    }
  }

  test('alone, takes about as long as when it keeps no span', async () => {
    const deflate = new Deflate({ gzip: true });
    for (let n = 0; n < FLUSHED_ROWS; n++) {
      deflate.push(rows(n, 1), Z_SYNC_FLUSH);
    }
    deflate.push(new Uint8Array(0), true);
    const flushed = deflate.result;
    const alone = await fastest(SAMPLES, () => passAndRead(flushed, ALONE));
    const part = await fastest(SAMPLES, () =>
      passAndRead(flushed, partBudget(PARTS)),
    );
    expect(alone).toBeLessThan(SLOWER_AT_MOST * part);
  });
});
