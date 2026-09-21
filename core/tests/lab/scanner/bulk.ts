/**
 * @fileoverview BulkIndex is RowIndex's block bookkeeping with one addition:
 * beginMany, which takes a run of begins at once.
 *
 * RowIndex keeps one entry per block of rows, a block closing at
 * `blockRows` rows or `blockBytes` bytes, so of every run of begins only the
 * ones that open a block matter. beginMany jumps straight to each: the row
 * limit is a fixed distance ahead, and the byte limit is found by binary
 * search, since begins rise. Fed per record, RowIndex pays a call and a
 * few loads for every record; this pays a few steps per block.
 * scanner.test.ts checks that both build the same blocks.
 */

import type { Tuning } from '@engine/rows';
import type { Begins } from './common.ts';

/** Entries the block arrays start with. */
const INITIAL_BLOCKS = 64;

/** BulkIndex records where each block of rows starts, as RowIndex does. */
export class BulkIndex {
  private firsts = new Float64Array(INITIAL_BLOCKS);
  private offsets = new Float64Array(INITIAL_BLOCKS);
  /** Blocks opened so far. */
  blocks = 0;
  /** Records begun so far. */
  counted = 0;

  constructor(
    private readonly tuning: Pick<Tuning, 'blockRows' | 'blockBytes'>,
  ) {}

  /** The first row of a block. */
  firstRow(block: number): number {
    return this.firsts[block]!;
  }

  /** The first byte of a block. */
  firstByte(block: number): number {
    return this.offsets[block]!;
  }

  /** begin is RowIndex.begin: the next record starts at `offset`. */
  begin(offset: number): void {
    const b = this.blocks;
    if (
      b === 0 ||
      this.counted - this.firsts[b - 1]! >= this.tuning.blockRows ||
      offset - this.offsets[b - 1]! >= this.tuning.blockBytes
    ) {
      this.open(offset);
    }
    this.counted++;
  }

  /**
   * beginMany is `begin(base + begins[k])` for every k below `count`, in
   * order, touching only the begins that open a block.
   */
  beginMany(begins: Begins, count: number, base: number): void {
    const { blockRows, blockBytes } = this.tuning;
    let k = 0;
    while (k < count) {
      const b = this.blocks;
      if (b === 0) {
        this.open(base + begins[k]!);
        this.counted++;
        k++;
        continue;
      }
      // The begin that fills the current block by rows, and the first in
      // reach of it that reaches its byte limit.
      const byRows =
        k + Math.max(0, this.firsts[b - 1]! + blockRows - this.counted);
      const reach = Math.min(byRows, count);
      const threshold = this.offsets[b - 1]! + blockBytes - base;
      const opens = firstAtLeast(begins, k, reach, threshold);
      if (opens === count) {
        this.counted += count - k;
        return;
      }
      this.counted += opens - k;
      this.open(base + begins[opens]!);
      this.counted++;
      k = opens + 1;
    }
  }

  /** open starts a block at the record numbered `counted`. */
  private open(offset: number): void {
    const b = this.blocks;
    if (b === this.firsts.length) {
      this.firsts = grow(this.firsts);
      this.offsets = grow(this.offsets);
    }
    this.firsts[b] = this.counted;
    this.offsets[b] = offset;
    this.blocks = b + 1;
  }
}

/**
 * firstAtLeast is the first index in [from, to) whose begin is at least
 * `threshold`, or `to` when none is. The begins rise.
 */
function firstAtLeast(
  begins: Begins,
  from: number,
  to: number,
  threshold: number,
): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (begins[mid]! >= threshold) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function grow(a: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const b = new Float64Array(a.length * 2);
  b.set(a);
  return b;
}
