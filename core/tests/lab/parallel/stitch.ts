/**
 * @fileoverview Stitching: walks chunk scans in file order with the true
 * scanner state and feeds a RowIndex the begins the sequential scan would
 * have fed it.
 *
 * "record" calls RowIndex.begin once per record, as indexPass does. "block"
 * calls it once per block and counts the records between by adding to
 * RowIndex.counted: the begins are in order, so the record that starts the
 * next block is found by arithmetic for the row limit and a binary search for
 * the byte limit. In core this would be a RowIndex method taking a run of
 * begins.
 */

import type { RowIndex, Tuning } from '@engine';
import { LINE, trace } from './speculate.ts';
import type { ChunkScan, State } from './speculate.ts';

/** How the stitcher hands begins to the index. */
export type StitchMode = 'record' | 'block';

/** Stitcher feeds one fresh RowIndex from chunk scans given in file order. */
export class Stitcher {
  private readonly index: RowIndex;
  private readonly tuning: Pick<Tuning, 'blockRows' | 'blockBytes'>;
  private readonly mode: StitchMode;
  /** The true scanner state at the next chunk's first byte. */
  private state: State = LINE;
  /** Where the next chunk must start. */
  private next: number;
  /** Whether the index holds a block yet, and where its last one starts. */
  private opened = false;
  private blockFirst = 0;
  private blockOffset = 0;

  /** `start` is where the pass starts scanning, in state LINE. */
  constructor(
    index: RowIndex,
    tuning: Pick<Tuning, 'blockRows' | 'blockBytes'>,
    mode: StitchMode,
    start: number,
  ) {
    if (index.counted !== 0) throw new Error('the index is not fresh');
    this.index = index;
    this.tuning = tuning;
    this.mode = mode;
    this.next = start;
  }

  /** add feeds the index one chunk's begins. Chunks come in file order. */
  add(scan: ChunkScan): void {
    if (scan.base !== this.next) {
      throw new Error(
        `a chunk at ${scan.base} came where ${this.next} was due`,
      );
    }
    const { ranges, end } = trace(scan, this.state);
    for (const [from, to] of ranges) {
      if (this.mode === 'record') this.addRecords(scan.begins, from, to);
      else this.addBlocks(scan.begins, from, to);
    }
    this.state = end;
    this.next = scan.base + scan.length;
  }

  private addRecords(begins: Float64Array, from: number, to: number): void {
    for (let k = from; k < to; k++) this.index.begin(begins[k]!);
  }

  private addBlocks(begins: Float64Array, from: number, to: number): void {
    const index = this.index;
    const { blockRows, blockBytes } = this.tuning;
    let k = from;
    while (k < to) {
      if (!this.opened) {
        this.open(begins[k]!);
        k++;
        continue;
      }
      // The first record past the block's row limit, or past its byte limit.
      const byRows =
        k + Math.max(0, this.blockFirst + blockRows - index.counted);
      const limit = Math.min(byRows, to);
      const next = firstAtLeast(
        begins,
        this.blockOffset + blockBytes,
        k,
        limit,
      );
      // The records before it join the current block.
      index.counted += next - k;
      k = next;
      if (k < to) {
        this.open(begins[k]!);
        k++;
      }
    }
  }

  /** open hands the index a record that starts a block. */
  private open(offset: number): void {
    this.opened = true;
    this.blockFirst = this.index.counted;
    this.blockOffset = offset;
    this.index.begin(offset);
  }
}

/**
 * firstAtLeast returns the first index in [lo, hi) whose value is at least
 * `value`, or `hi`. The values are in increasing order.
 */
function firstAtLeast(
  values: Float64Array,
  value: number,
  lo: number,
  hi: number,
): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
