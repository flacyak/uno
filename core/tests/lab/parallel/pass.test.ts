/**
 * @fileoverview The parallel index pass builds the same RowIndex as core's
 * indexPass: same block firsts and offsets, same count, same bytes scanned.
 * Checked on random input cut into tiny chunks on this thread, and on the
 * 96 MB sales fixture, the efficiency test's synthetic CSV and the
 * adversarial shapes through a real worker pool, from memory and from disk.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { TUNING, indexPass } from '@engine';
import type { Tuning } from '@engine';
import { peekFormat } from '@ingest';
import type { HeaderMode } from '@ingest';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { nodeSource } from '@store/node';
import { repeated } from '@core-tests/testdata/sales-q3';
import {
  contextFor,
  difference,
  parallelIndex,
  sequentialIndex,
} from './indexes.ts';
import { inlineScanner, parallelIndexPass, planFor } from './pass.ts';
import type { ChunkScanner } from './pass.ts';
import { ScanPool } from './pool.ts';
import {
  ALTERNATING,
  BARE_QUOTES,
  EMPTY_QUOTES,
  PLAIN,
  QUOTE_RUN,
  SYNTHETIC,
} from './shapes.ts';
import type { StitchMode } from './stitch.ts';

const encoder = new TextEncoder();
const STITCHES: readonly StitchMode[] = ['record', 'block'];
const HEADERS: readonly HeaderMode[] = ['first', 'none'];

/** formatOf sniffs a source as a .csv, as the engine opens one. */
async function formatOf(source: ByteSource, header: HeaderMode = 'first') {
  return peekFormat('lab.csv', source, header);
}

/**
 * expectSame builds the index both ways over `source` and expects no
 * difference, for every stitch mode.
 */
async function expectSame(
  source: ByteSource,
  tuning: Tuning,
  scanner: ChunkScanner,
  scanners: number,
  header: HeaderMode = 'first',
  label = '',
): Promise<void> {
  const format = await formatOf(source, header);
  if (format === undefined) return;
  const want = await sequentialIndex(source, format, tuning);
  for (const stitch of STITCHES) {
    const reads = 1 + (scanners % 3);
    const got = await parallelIndex(
      source,
      format,
      tuning,
      scanner,
      planFor(scanners, reads, stitch),
    );
    expect(difference(got, want), `${label} ${stitch}`).toBeUndefined();
  }
}

/** mulberry32 random number generator. A failure reports its seed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The alphabet of tests/ingest/scan.test.ts.
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
  '﻿',
];
const BOM_CHANCE = 0.1;
const MAX_CHARS = 60;
const SEEDS = 1500;

function csvish(rand: () => number): string {
  let s = rand() < BOM_CHANCE ? '﻿' : '';
  const n = Math.floor(rand() * MAX_CHARS);
  for (let i = 0; i < n; i++)
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** Tiny blocks, so random files of a few dozen bytes span many. */
const SMALL_BLOCKS: Omit<Tuning, 'chunkBytes'> = {
  blockRows: 2,
  blockBytes: 8,
  cacheBytes: 0,
};
/** Chunk sizes for random input: every byte its own chunk, and up. */
const SMALL_CHUNKS = [1, 2, 3, 7, 64];

test('on random input, in any chunk size, either header mode', async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = random(seed);
    const text = csvish(rand);
    const source = bytesSource(encoder.encode(text));
    for (const header of HEADERS) {
      for (const chunkBytes of SMALL_CHUNKS) {
        await expectSame(
          source,
          { ...SMALL_BLOCKS, chunkBytes },
          inlineScanner,
          1 + (seed % 4),
          header,
          `seed ${seed} ${header} chunk ${chunkBytes}: ${JSON.stringify(text)}`,
        );
      }
    }
  }
}, 120_000);

/** The chunk after which the abort test aborts, and its chunk size. */
const ABORT_AFTER = 3;
const ABORT_CHUNK_BYTES = 4096;

test('an aborted pass stops where indexPass stops', async () => {
  const source = bytesSource(SYNTHETIC.make(1 << 20));
  const format = await formatOf(source);
  if (format === undefined) throw new Error('the file read as empty');
  const tuning = { ...TUNING, chunkBytes: ABORT_CHUNK_BYTES };

  /** A context whose signal aborts at the ABORT_AFTER'th progress. */
  const aborting = () => {
    const ctx = contextFor(source, format, tuning);
    const abort = new AbortController();
    let chunks = 0;
    return {
      ...ctx,
      signal: abort.signal,
      progress: () => {
        if (++chunks === ABORT_AFTER) abort.abort();
      },
    };
  };
  const want = aborting();
  await indexPass(want);
  const got = aborting();
  await parallelIndexPass(got, inlineScanner, planFor(2, 2, 'block'));

  expect(want.index.complete).toBe(false);
  expect(want.index.scanned).toBe(
    format.dataStart + ABORT_AFTER * ABORT_CHUNK_BYTES,
  );
  expect(difference(got.index, want.index)).toBeUndefined();
});

/** Workers in the pool the larger checks run on. */
const WORKERS = 4;
/** 96 MB and 1,924,800 rows. */
const REPEATS = 400;
/** Chunk sizes that are not a power of two, so cuts land all over the rows. */
const ODD_CHUNKS = [(1 << 20) + 7, (3 << 20) - 1];
/** A size for the synthetic and adversarial files. */
const SHAPE_BYTES = 24 << 20;

describe('through a worker pool', () => {
  let pool: ScanPool;
  let folder = '';
  beforeAll(async () => {
    pool = await ScanPool.start(WORKERS);
    folder = await mkdtemp(join(tmpdir(), 'uno-lab-parallel-'));
  });
  afterAll(async () => {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  });

  test('the 96 MB sales fixture, copied, shared and cut oddly', async () => {
    const bytes = repeated(REPEATS);
    // A view of part of a buffer is copied on its way to a worker.
    await expectSame(
      bytesSource(bytes),
      TUNING,
      pool,
      WORKERS,
      'first',
      'copied',
    );
    expect(pool.handoffs.copied).toBeGreaterThan(0);

    // On shared memory it is shared as it is.
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
    shared.set(bytes);
    const before = pool.handoffs.copied;
    for (const chunkBytes of [TUNING.chunkBytes, ...ODD_CHUNKS]) {
      await expectSame(
        bytesSource(shared),
        { ...TUNING, chunkBytes },
        pool,
        WORKERS,
        'first',
        `shared, chunk ${chunkBytes}`,
      );
    }
    expect(pool.handoffs.copied).toBe(before);
    expect(pool.handoffs.shared).toBeGreaterThan(0);
  }, 120_000);

  test('the synthetic CSV of the efficiency index test', async () => {
    const source = bytesSource(SYNTHETIC.make(SHAPE_BYTES));
    for (const chunkBytes of [TUNING.chunkBytes, ...ODD_CHUNKS]) {
      for (const header of HEADERS) {
        await expectSame(
          source,
          { ...TUNING, chunkBytes },
          pool,
          WORKERS,
          header,
          `chunk ${chunkBytes} ${header}`,
        );
      }
    }
  }, 120_000);

  test('the shapes that keep paths apart, and one with no quotes', async () => {
    for (const shape of [PLAIN, EMPTY_QUOTES, BARE_QUOTES, ALTERNATING]) {
      const source = bytesSource(shape.make(SHAPE_BYTES));
      for (const chunkBytes of ODD_CHUNKS) {
        await expectSame(
          source,
          { ...TUNING, chunkBytes },
          pool,
          WORKERS,
          'first',
          shape.name,
        );
      }
    }
    // A run of quotes is stepped byte by byte, so it is kept short.
    const run = bytesSource(QUOTE_RUN.make(1 << 20));
    await expectSame(run, { ...TUNING, chunkBytes: 4093 }, pool, WORKERS);
  }, 120_000);

  test('a file on disk, its chunks transferred', async () => {
    const path = join(folder, 'synthetic.csv');
    await writeFile(path, SYNTHETIC.make(SHAPE_BYTES));
    const source = await nodeSource(path);
    try {
      const before = pool.handoffs.transferred;
      await expectSame(
        source,
        { ...TUNING, chunkBytes: ODD_CHUNKS[0]! },
        pool,
        WORKERS,
      );
      expect(pool.handoffs.transferred).toBeGreaterThan(before);
    } finally {
      await source.close();
    }
  }, 120_000);
});
