/**
 * @fileoverview A skeptic's check of the parallel index pass and the block
 * stitch: RowIndex compared field by field, private arrays included, over
 * random tunings, chunk sizes, both header modes and both stitch modes; the
 * Stitcher fed chunks of uneven length; a source that has shrunk; aborts
 * after every chunk; offsets past 2^32 through real workers; and what the
 * main thread does during a pass.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { RowIndex, indexPass } from '@engine';
import type { Tuning } from '@engine';
import { peekFormat } from '@ingest';
import type { Format, HeaderMode } from '@ingest';
import { UnsupportedEncodingError } from '@ingest/format';
import { RecordScanner } from '@ingest/scan';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { contextFor } from '../../parallel/indexes.ts';
import {
  inlineScanner,
  parallelIndexPass,
  planFor,
} from '../../parallel/pass.ts';
import type { ChunkScanner } from '../../parallel/pass.ts';
import { ScanPool } from '../../parallel/pool.ts';
import { SYNTHETIC } from '../../parallel/shapes.ts';
import { scanChunk, separatorOf } from '../../parallel/speculate.ts';
import { Stitcher } from '../../parallel/stitch.ts';
import type { StitchMode } from '../../parallel/stitch.ts';
import { SEPARATORS, gnarly, random, randomLengths } from './gen.ts';

const encoder = new TextEncoder();
const STITCHES: readonly StitchMode[] = ['record', 'block'];
const HEADERS: readonly HeaderMode[] = ['first', 'none'];

/** The private fields of RowIndex, read to compare two exactly. */
interface IndexInside {
  firsts: Float64Array;
  offsets: Float64Array;
  blocks: number;
}

/** snapshot is everything a RowIndex holds, as plain data. */
function snapshot(index: RowIndex): object {
  const inner = index as unknown as IndexInside;
  return {
    start: index.start,
    size: index.size,
    counted: index.counted,
    scanned: index.scanned,
    complete: index.complete,
    blocks: inner.blocks,
    firsts: Array.from(inner.firsts.subarray(0, inner.blocks)),
    offsets: Array.from(inner.offsets.subarray(0, inner.blocks)),
  };
}

/** randomTuning draws block limits from the edges and the middle. */
function randomTuning(rand: () => number, chunkBytes: number): Tuning {
  const rows = [0, 1, 2, 3, 5, 1024];
  const bytes = [0, 1, 2, 5, 8, 13, 64, 1 << 20];
  return {
    chunkBytes,
    blockRows: rows[Math.floor(rand() * rows.length)]!,
    blockBytes: bytes[Math.floor(rand() * bytes.length)]!,
    cacheBytes: 0,
  };
}

async function sequential(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
): Promise<RowIndex> {
  const ctx = contextFor(source, format, tuning);
  await indexPass(ctx);
  return ctx.index;
}

async function parallel(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
  scanner: ChunkScanner,
  stitch: StitchMode,
  scanners: number,
  reads: number,
): Promise<RowIndex> {
  const ctx = contextFor(source, format, tuning);
  await parallelIndexPass(ctx, scanner, planFor(scanners, reads, stitch));
  return ctx.index;
}

/** formatWith sniffs a format, then forces the separator under test. */
async function formatOf(
  source: ByteSource,
  header: HeaderMode,
  comma: string,
): Promise<Format | undefined> {
  let sniffed: Format | undefined;
  try {
    sniffed = await peekFormat('lab.csv', source, header);
  } catch (err) {
    // NUL bytes in random input can sniff as UTF-16, which core refuses.
    if (err instanceof UnsupportedEncodingError) return undefined;
    throw err;
  }
  if (sniffed === undefined) return undefined;
  return {
    ...sniffed,
    delimiter: comma,
    scanner: (begin) => new RecordScanner(comma, begin),
  };
}

const SEEDS = 1500;

describe('the parallel pass builds the same RowIndex, field by field', () => {
  test('random input, tuning, chunk size, header and stitch', async () => {
    let bomUnderNone = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed + 7_000_000);
      const comma = rand() < 0.5 ? ',' : SEPARATORS[seed % SEPARATORS.length]!;
      const bytes = encoder.encode(gnarly(rand, Math.floor(rand() * 70)));
      const source = bytesSource(bytes);
      for (const header of HEADERS) {
        const format = await formatOf(source, header, comma);
        if (format === undefined) continue;
        if (header === 'none' && format.dataStart === 3) bomUnderNone++;
        const chunkBytes = 1 + Math.floor(rand() * 20);
        const tuning = randomTuning(rand, chunkBytes);
        const want = snapshot(await sequential(source, format, tuning));
        for (const stitch of STITCHES) {
          const got = await parallel(
            source,
            format,
            tuning,
            inlineScanner,
            stitch,
            1 + Math.floor(rand() * 4),
            1 + Math.floor(rand() * 3),
          );
          expect(
            snapshot(got),
            `seed ${seed} ${header} ${stitch} ${JSON.stringify(tuning)}`,
          ).toEqual(want);
        }
      }
    }
    expect(bomUnderNone).toBeGreaterThan(0);
  }, 300_000);

  // Files whose last byte is a CR that would start a record, a record
  // longer than every chunk and block, and a CR right at a chunk edge.
  const EDGES = [
    'a\n\r',
    'a\r',
    '\r',
    'x,y\n"a"\r',
    'x,y\n"a\r',
    'x\n\r\r\r\r',
    'x\n\r"q"\n',
    'x\n' + '"'.repeat(41) + '\r\n' + 'z',
    '\uFEFFa,b\r\n\r\nc,d\r',
    'h\n' + 'v'.repeat(97) + '\n' + 'w',
  ];
  test('edge files in every chunk size up to their length', async () => {
    for (const text of EDGES) {
      const bytes = encoder.encode(text);
      const source = bytesSource(bytes);
      for (const header of HEADERS) {
        const format = await formatOf(source, header, ',');
        if (format === undefined) continue;
        for (let chunkBytes = 1; chunkBytes <= bytes.length + 1; chunkBytes++) {
          for (const [blockRows, blockBytes] of [
            [1, 1],
            [2, 4],
            [1024, 1 << 20],
          ]) {
            const tuning: Tuning = {
              chunkBytes,
              blockRows: blockRows!,
              blockBytes: blockBytes!,
              cacheBytes: 0,
            };
            const want = snapshot(await sequential(source, format, tuning));
            for (const stitch of STITCHES) {
              const got = await parallel(
                source,
                format,
                tuning,
                inlineScanner,
                stitch,
                2,
                2,
              );
              expect(
                snapshot(got),
                `${JSON.stringify(text)} ${header} ${chunkBytes} ${stitch}`,
              ).toEqual(want);
            }
          }
        }
      }
    }
  });

  test('tunings no default holds: fractions, Infinity', async () => {
    const odd: Array<[number, number]> = [
      [2.5, 8],
      [2, 7.5],
      [Infinity, 8],
      [2, Infinity],
      [Infinity, Infinity],
    ];
    const misses: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const rand = random(seed + 17_000_000);
      const bytes = encoder.encode(gnarly(rand, Math.floor(rand() * 70)));
      const source = bytesSource(bytes);
      const format = await formatOf(source, 'none', ',');
      if (format === undefined) continue;
      for (const [blockRows, blockBytes] of odd) {
        const tuning: Tuning = {
          chunkBytes: 1 + (seed % 9),
          blockRows,
          blockBytes,
          cacheBytes: 0,
        };
        const want = JSON.stringify(
          snapshot(await sequential(source, format, tuning)),
        );
        const got = JSON.stringify(
          snapshot(
            await parallel(
              source,
              format,
              tuning,
              inlineScanner,
              'block',
              2,
              2,
            ),
          ),
        );
        if (got !== want)
          misses.push(`seed ${seed} rows ${blockRows} bytes ${blockBytes}`);
      }
    }
    console.log(
      `odd tunings that differ in block mode: ${misses.length}`,
      misses.slice(0, 5),
    );
  });
});

/** Where block starts fell, counted to show each case came up. */
interface BlockEdges {
  atChunkStart: number;
  atCrBeforeChunk: number;
  lastChunk: number;
}

describe('the block stitch, fed chunks of uneven length', () => {
  test('matches RowIndex.begin per record, wherever blocks and chunks fall', () => {
    const edges: BlockEdges = {
      atChunkStart: 0,
      atCrBeforeChunk: 0,
      lastChunk: 0,
    };
    for (let seed = 1; seed <= 6000; seed++) {
      const rand = random(seed + 9_000_000);
      const comma = SEPARATORS[seed % SEPARATORS.length]!;
      const sep = separatorOf(comma);
      const bytes = encoder.encode(gnarly(rand, Math.floor(rand() * 80)));
      const base = rand() < 0.2 ? 2 ** 32 + 3 : 0;
      const size = base + bytes.length;
      const tuning = randomTuning(rand, 0);

      const want = new RowIndex(base, size, tuning);
      new RecordScanner(comma, (offset) => want.begin(offset)).push(
        bytes,
        base,
      );

      const got = new RowIndex(base, size, tuning);
      // One begin per block: the stitch must find each block's first record
      // itself, not lean on RowIndex.begin to fold extra calls into a block.
      let calls = 0;
      const begin = got.begin.bind(got);
      got.begin = (offset) => {
        calls++;
        begin(offset);
      };
      const stitcher = new Stitcher(got, tuning, 'block', base);
      const lengths = randomLengths(rand, bytes.length);
      const chunkStarts = new Set<number>();
      let at = 0;
      for (const length of lengths) {
        chunkStarts.add(base + at);
        stitcher.add(
          scanChunk(bytes.subarray(at, at + length), base + at, sep),
        );
        at += length;
      }
      expect(snapshot(got), `seed ${seed} ${JSON.stringify(tuning)}`).toEqual(
        snapshot(want),
      );
      const inner = want as unknown as IndexInside;
      expect(calls, `seed ${seed} begin calls`).toBe(inner.blocks);

      const lastStart = base + bytes.length - (lengths.at(-1) ?? 0);
      for (let b = 1; b < inner.blocks; b++) {
        const offset = inner.offsets[b]!;
        if (chunkStarts.has(offset)) edges.atChunkStart++;
        if (chunkStarts.has(offset + 1) && bytes[offset - base] === 0x0d) {
          edges.atCrBeforeChunk++;
        }
        if (offset >= lastStart) edges.lastChunk++;
      }
    }
    expect(edges.atChunkStart).toBeGreaterThan(0);
    expect(edges.atCrBeforeChunk).toBeGreaterThan(0);
    expect(edges.lastChunk).toBeGreaterThan(0);
  });
});

/**
 * shrunk is a source whose size says `size` but whose bytes stop at `kept`,
 * as a file that shrank after it was opened reads.
 */
function shrunk(bytes: Uint8Array, kept: number): ByteSource {
  const left = bytes.subarray(0, kept);
  return {
    size: bytes.length,
    read: (offset, length) =>
      Promise.resolve(
        left.subarray(Math.min(offset, kept), Math.min(offset + length, kept)),
      ),
    close: () => Promise.resolve(),
  };
}

describe('a file that shrank', () => {
  test('stops where indexPass stops, at a chunk edge or inside one', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = random(seed + 11_000_000);
      const bytes = encoder.encode(gnarly(rand, 20 + Math.floor(rand() * 60)));
      const whole = bytesSource(bytes);
      const format = await formatOf(whole, 'none', ',');
      if (format === undefined) continue;
      const chunkBytes = 1 + Math.floor(rand() * 9);
      const tuning = randomTuning(rand, chunkBytes);
      for (let kept = format.dataStart; kept <= bytes.length; kept++) {
        const source = shrunk(bytes, kept);
        const want = snapshot(await sequential(source, format, tuning));
        for (const stitch of STITCHES) {
          const got = await parallel(
            source,
            format,
            tuning,
            inlineScanner,
            stitch,
            2,
            2,
          );
          expect(snapshot(got), `seed ${seed} kept ${kept} ${stitch}`).toEqual(
            want,
          );
        }
      }
    }
  }, 300_000);
});

describe('an abort', () => {
  test('after any chunk leaves the index indexPass leaves', async () => {
    const bytes = SYNTHETIC.make(1 << 16);
    const source = bytesSource(bytes);
    const format = await formatOf(source, 'first', ',');
    if (format === undefined) throw new Error('empty');
    const tuning: Tuning = {
      chunkBytes: 997,
      blockRows: 7,
      blockBytes: 300,
      cacheBytes: 0,
    };
    const chunks = Math.ceil((bytes.length - format.dataStart) / 997);
    const aborting = (after: number) => {
      const ctx = contextFor(source, format, tuning);
      const abort = new AbortController();
      let seen = 0;
      return {
        ...ctx,
        signal: abort.signal,
        progress: () => {
          if (++seen === after) abort.abort();
        },
      };
    };
    for (let after = 1; after <= chunks; after++) {
      const want = aborting(after);
      await indexPass(want);
      for (const stitch of STITCHES) {
        const got = aborting(after);
        await parallelIndexPass(got, inlineScanner, planFor(3, 2, stitch));
        expect(snapshot(got.index), `after ${after} ${stitch}`).toEqual(
          snapshot(want.index),
        );
      }
    }
  });

  test('leaves reads running after the pass has returned', async () => {
    const bytes = SYNTHETIC.make(1 << 16);
    let reads = 0;
    const inner = bytesSource(bytes);
    const source: ByteSource = {
      size: inner.size,
      read: (offset, length) => {
        reads++;
        return inner.read(offset, length);
      },
      close: () => inner.close(),
    };
    const format = await formatOf(source, 'first', ',');
    if (format === undefined) throw new Error('empty');
    const tuning: Tuning = {
      chunkBytes: 997,
      blockRows: 7,
      blockBytes: 300,
      cacheBytes: 0,
    };
    const ctx = contextFor(source, format, tuning);
    const abort = new AbortController();
    reads = 0;
    await parallelIndexPass(
      {
        ...ctx,
        signal: abort.signal,
        progress: () => abort.abort(),
      },
      inlineScanner,
      planFor(4, 2, 'block'),
    );
    const atReturn = reads;
    await new Promise((go) => setImmediate(go));
    // One chunk was stitched; the window's other chunks are read anyway.
    console.log(
      `reads for a pass aborted after one chunk: ${atReturn} when it returned, ${reads} a turn later`,
    );
    expect(reads).toBeGreaterThan(1);
  });
});

/** Worker threads in the pool these checks run on. */
const WORKERS = 3;

describe('through a worker pool', () => {
  let pool: ScanPool;
  beforeAll(async () => {
    pool = await ScanPool.start(WORKERS);
  });
  afterAll(async () => {
    await pool.close();
  });

  test('random input in tiny chunks, both stitches', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rand = random(seed + 13_000_000);
      const bytes = encoder.encode(gnarly(rand, 20 + Math.floor(rand() * 60)));
      const source = bytesSource(bytes);
      for (const header of HEADERS) {
        const format = await formatOf(source, header, ',');
        if (format === undefined) continue;
        const tuning = randomTuning(rand, 1 + Math.floor(rand() * 9));
        const want = snapshot(await sequential(source, format, tuning));
        for (const stitch of STITCHES) {
          const got = await parallel(
            source,
            format,
            tuning,
            pool,
            stitch,
            WORKERS,
            2,
          );
          expect(snapshot(got), `seed ${seed} ${header} ${stitch}`).toEqual(
            want,
          );
        }
      }
    }
  }, 120_000);

  test('offsets past 2^32, through structured clone', async () => {
    const body = SYNTHETIC.make(1 << 18);
    const sample = bytesSource(body);
    const sniffed = await formatOf(sample, 'none', ',');
    if (sniffed === undefined) throw new Error('empty');
    for (const start of [2 ** 31 - 11, 2 ** 32 - 1, 2 ** 32 + 5, 2 ** 45 + 3]) {
      // A source that is all zeros before `start`, never read, then `body`.
      const source: ByteSource = {
        size: start + body.length,
        read: (offset, length) => {
          const from = offset - start;
          // A fresh buffer per read, as nodeSource gives, so it is transferred.
          return Promise.resolve(body.slice(from, from + length));
        },
        close: () => Promise.resolve(),
      };
      const format: Format = { ...sniffed, dataStart: start };
      const tuning: Tuning = {
        chunkBytes: 4093,
        blockRows: 50,
        blockBytes: 3000,
        cacheBytes: 0,
      };
      const want = snapshot(await sequential(source, format, tuning));
      for (const stitch of STITCHES) {
        const got = await parallel(
          source,
          format,
          tuning,
          pool,
          stitch,
          WORKERS,
          2,
        );
        expect(snapshot(got), `start ${start} ${stitch}`).toEqual(want);
      }
    }
  }, 120_000);

  test('a one-chunk file at offset 0 is transferred out of its source', async () => {
    // Under header "none" with no byte order mark the first chunk starts at
    // 0, and when the file fits in one chunk bytesSource hands back a view
    // of its whole buffer. ScanPool transfers such a buffer.
    const bytes = encoder.encode('a,b\nc,d\ne,f\n');
    const size = bytes.length;
    const source = bytesSource(bytes);
    const format = await formatOf(source, 'none', ',');
    if (format === undefined) throw new Error('empty');
    expect(format.dataStart).toBe(0);
    const tuning: Tuning = {
      chunkBytes: 8 << 20,
      blockRows: 1024,
      blockBytes: 1 << 20,
      cacheBytes: 0,
    };
    const want = snapshot(await sequential(source, format, tuning));
    const before = pool.handoffs.transferred;
    const got = await parallel(
      source,
      format,
      tuning,
      pool,
      'block',
      WORKERS,
      2,
    );
    expect(snapshot(got)).toEqual(want);
    expect(pool.handoffs.transferred).toBe(before + 1);
    // The caller's bytes are gone: the buffer is detached, and every later
    // read of the source, a page of rows included, throws.
    console.log(`after the pool pass: bytes.length ${bytes.length} of ${size}`);
    expect(bytes.length).toBe(0);
    // bytesSource's read calls subarray first, so it throws as it is called.
    expect(() => source.read(0, size)).toThrow(/detached/);
  });

  test('main thread: begin calls per block, not per record, in block mode', async () => {
    const bytes = SYNTHETIC.make(4 << 20);
    const source = bytesSource(bytes);
    const format = await formatOf(source, 'first', ',');
    if (format === undefined) throw new Error('empty');
    const tuning: Tuning = {
      chunkBytes: 1 << 20,
      blockRows: 1024,
      blockBytes: 1 << 20,
      cacheBytes: 0,
    };
    for (const stitch of STITCHES) {
      const ctx = contextFor(source, format, tuning);
      let begins = 0;
      const begin = ctx.index.begin.bind(ctx.index);
      ctx.index.begin = (offset) => {
        begins++;
        begin(offset);
      };
      const copied = pool.handoffs.copiedBytes;
      await parallelIndexPass(ctx, pool, planFor(WORKERS, 2, stitch));
      const blocks = (ctx.index as unknown as IndexInside).blocks;
      console.log(
        `${stitch}: ${ctx.index.counted} records, ${blocks} blocks, ${begins} begin calls, ${pool.handoffs.copiedBytes - copied} bytes copied on the main thread`,
      );
      if (stitch === 'block') expect(begins).toBe(blocks);
      else expect(begins).toBe(ctx.index.counted);
    }
  }, 120_000);

  test('main thread: how many macrotask turns run during a pass', async () => {
    const bytes = SYNTHETIC.make(8 << 20);
    const source = bytesSource(bytes);
    const format = await formatOf(source, 'first', ',');
    if (format === undefined) throw new Error('empty');
    const tuning: Tuning = {
      chunkBytes: 1 << 20,
      blockRows: 1024,
      blockBytes: 1 << 20,
      cacheBytes: 0,
    };

    /** turns counts setImmediate turns that run while `run` is pending. */
    const turns = async (run: () => Promise<void>): Promise<number> => {
      let count = 0;
      let done = false;
      const tick = (): void => {
        if (done) return;
        count++;
        setImmediate(tick);
      };
      setImmediate(tick);
      await run();
      done = true;
      return count;
    };

    const seq = await turns(() =>
      indexPass(contextFor(source, format, tuning)),
    );
    const inline = await turns(() =>
      parallelIndexPass(
        contextFor(source, format, tuning),
        inlineScanner,
        planFor(WORKERS, 2, 'block'),
      ),
    );
    const pooled = await turns(() =>
      parallelIndexPass(
        contextFor(source, format, tuning),
        pool,
        planFor(WORKERS, 2, 'block'),
      ),
    );
    const chunks = Math.ceil(
      (bytes.length - format.dataStart) / tuning.chunkBytes,
    );
    console.log(
      `macrotask turns over ${chunks} chunks from memory: indexPass ${seq}, inline ${inline}, pool ${pooled}`,
    );
    expect(pooled).toBeGreaterThan(0);

    // How many chunks the pool pass stitches with no macrotask between them.
    for (const stitch of STITCHES) {
      let turn = 0;
      let done = false;
      const tick = (): void => {
        if (done) return;
        turn++;
        setImmediate(tick);
      };
      setImmediate(tick);
      const perTurn = new Map<number, number>();
      const plan = {
        ...planFor(WORKERS, 2, stitch),
        observe: () => perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1),
      };
      await parallelIndexPass(contextFor(source, format, tuning), pool, plan);
      done = true;
      console.log(
        `${stitch}: most chunks stitched in one turn ${Math.max(...perTurn.values())}`,
      );
    }
  }, 120_000);
});
