/**
 * @fileoverview Passes: work that reads a whole file one chunk at a time.
 *
 * A pass reads a chunk, does its work, reports progress, and stops when its
 * signal is aborted. PassContext is what every pass is handed.
 */

import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import type { RowIndex, Tuning } from './rows.ts';

/**
 * A Tap is handed each block the index pass completes, before the chunk's
 * progress, with a reader of the block's bytes out of the pass's own chunks.
 */
export type Tap = (block: number, bytes: () => Uint8Array) => Promise<void>;

export interface PassContext {
  readonly source: ByteSource;
  readonly format: Format;
  readonly index: RowIndex;
  readonly tuning: Tuning;
  /** Checked between chunks. An aborted pass returns early. */
  readonly signal: AbortSignal;
  /** Called after every chunk. */
  progress(): void;
  /** Handed each block completed. Undefined for a pass nothing taps. */
  readonly tap?: Tap;
}

/**
 * indexPass reads from `index.scanned`, the first data record for a new index,
 * to the end of the file, and records where each block of rows starts.
 *
 * Each chunk read is awaited, so other work runs between chunks.
 */
export async function indexPass(ctx: PassContext): Promise<void> {
  const { source, format, index, tuning, signal } = ctx;
  const scanner = format.scanner((offset) => index.begin(offset));
  const carry = ctx.tap === undefined ? undefined : new Carry(index, ctx.tap);

  for (let at = index.scanned; at < source.size;) {
    if (signal.aborted) return;
    const chunk = await source.read(
      at,
      Math.min(tuning.chunkBytes, source.size - at),
    );
    if (chunk.length === 0) break; // the file shrank after it was opened
    scanner.push(chunk, at);
    at += chunk.length;
    index.scanned = at;
    await carry?.push(chunk, at);
    ctx.progress();
  }

  index.complete = true;
  await carry?.push(new Uint8Array(0), index.scanned);
  ctx.progress();
}

/**
 * Carry hands a tap each block the scan completes, whole, out of the chunks
 * alone: it keeps the bytes of the block the scan is in from one chunk to
 * the next, since a block may begin in one chunk and end in a later one.
 */
class Carry {
  private readonly index: RowIndex;
  private readonly tap: Tap;
  /** The chunks' bytes from the start of the first block not handed over. */
  private kept: Uint8Array = new Uint8Array(0);
  /** Where `kept` starts in the file. */
  private keptAt: number;
  /** How many blocks have been handed over. */
  private handed: number;

  constructor(index: RowIndex, tap: Tap) {
    this.index = index;
    this.tap = tap;
    this.keptAt = index.scanned;
    this.handed = index.begun;
  }

  /**
   * push takes in `chunk`, the scanned bytes ending at `end`, and hands over
   * each block that ends in them: every block begun but the last, which may
   * still grow, or every block once the scan is complete.
   */
  async push(chunk: Uint8Array, end: number): Promise<void> {
    const index = this.index;
    const at = end - chunk.length;
    const ended = index.complete ? index.begun : index.begun - 1;
    for (; this.handed < ended; this.handed++) {
      const [start, stop] = index.bytesOf(this.handed);
      // A block past the bytes scanned is one the file lost since it opened.
      if (stop > end) break;
      await this.tap(this.handed, () => this.slice(chunk, at, start, stop));
    }
    // What is left is the block the scan is in, or nothing.
    const begun = this.handed < index.begun;
    const from = begun ? index.bytesOf(this.handed)[0] : end;
    this.kept = this.slice(chunk, at, from, end);
    this.keptAt = from;
  }

  /** slice returns the bytes from `start` to `stop` out of what is kept and
   * `chunk`, which follows it from `at`. */
  private slice(
    chunk: Uint8Array,
    at: number,
    start: number,
    stop: number,
  ): Uint8Array {
    if (start >= at) return chunk.subarray(start - at, stop - at);
    const to = Math.min(stop, at) - this.keptAt;
    const kept = this.kept.subarray(start - this.keptAt, to);
    if (stop <= at) return kept;
    const out = new Uint8Array(stop - start);
    out.set(kept);
    out.set(chunk.subarray(0, stop - at), kept.length);
    return out;
  }
}
