/**
 * @fileoverview The parallel index pass: chunks are read with several reads
 * in flight, scanned speculatively wherever a ChunkScanner runs them, and
 * stitched into the RowIndex in file order.
 *
 * It builds the same RowIndex as indexPass in core/src/engine/pass.ts: the
 * same chunks from the same offsets, the same begins in the same order, and
 * `scanned` set after each chunk. Nothing here imports a platform module; the
 * ChunkScanner says where scans run.
 */

import type { PassContext } from '@engine';
import { scanChunk, separatorOf } from './speculate.ts';
import type { ChunkScan } from './speculate.ts';
import { Stitcher } from './stitch.ts';
import type { StitchMode } from './stitch.ts';

/** ChunkScanner scans a chunk from every start state, somewhere. */
export interface ChunkScanner {
  /**
   * scan may take ownership of the chunk's buffer, so the caller must not
   * use the chunk after handing it over.
   */
  scan(chunk: Uint8Array, base: number, sep: number): Promise<ChunkScan>;
}

/** inlineScanner scans on the calling thread. */
export const inlineScanner: ChunkScanner = {
  scan: (chunk, base, sep) => Promise.resolve(scanChunk(chunk, base, sep)),
};

/** Plan is how a parallel pass spends memory and reads. */
export interface Plan {
  /**
   * The most chunks between their read starting and their stitch ending. It
   * bounds the memory the pass holds to this many chunks.
   */
  readonly window: number;
  /** The most reads in flight at once. */
  readonly reads: number;
  readonly stitch: StitchMode;
  /** Called with each chunk scan once it is stitched, in file order. */
  readonly observe?: (scan: ChunkScan) => void;
}

/** Chunks a plan keeps at each scanner: the one it scans and one waiting. */
const HELD_PER_SCANNER = 2;

/**
 * planFor returns a plan that keeps `scanners` busy, with `reads` more chunks
 * being read while they scan.
 */
export function planFor(
  scanners: number,
  reads: number,
  stitch: StitchMode,
): Plan {
  return { window: scanners * HELD_PER_SCANNER + reads, reads, stitch };
}

/**
 * parallelIndexPass reads from the first data record to the end of the file
 * and records where each block of rows starts, as indexPass does.
 */
export async function parallelIndexPass(
  ctx: PassContext,
  scanner: ChunkScanner,
  plan: Plan,
): Promise<void> {
  const { source, format, index, tuning, signal } = ctx;
  const sep = separatorOf(format.delimiter);
  const stitcher = new Stitcher(index, tuning, plan.stitch, format.dataStart);
  const reads = new Limiter(plan.reads);

  const starts: number[] = [];
  for (let at = format.dataStart; at < source.size; at += tuning.chunkBytes) {
    starts.push(at);
  }
  const lengthOf = (k: number): number =>
    Math.min(tuning.chunkBytes, source.size - starts[k]!);

  const scans = new Map<number, Promise<ChunkScan>>();
  const issue = (k: number): void => {
    const at = starts[k]!;
    const scan = reads
      .run(() => source.read(at, lengthOf(k)))
      .then((bytes) => scanner.scan(bytes, at, sep));
    // The loop below reports a failure when it reaches the chunk.
    scan.catch(() => undefined);
    scans.set(k, scan);
  };

  let issued = 0;
  for (let k = 0; k < starts.length; k++) {
    for (; issued < starts.length && issued - k < plan.window; issued++) {
      issue(issued);
    }
    if (signal.aborted) return;
    const scan = await scans.get(k)!;
    scans.delete(k);
    if (scan.length === 0) break; // the file shrank after it was opened
    stitcher.add(scan);
    index.scanned = scan.base + scan.length;
    plan.observe?.(scan);
    ctx.progress();
    if (scan.length < lengthOf(k)) break; // a short read is the end of the file
  }

  index.complete = true;
  ctx.progress();
}

/** Limiter runs at most `limit` tasks at once, in the order they asked. */
class Limiter {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (limit < 1) throw new Error('a limiter runs at least one task');
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) this.running++;
    else await new Promise<void>((go) => this.waiting.push(go));
    try {
      return await task();
    } finally {
      // A waiting task takes this one's place, so the count stays.
      const next = this.waiting.shift();
      if (next === undefined) this.running--;
      else next();
    }
  }
}
