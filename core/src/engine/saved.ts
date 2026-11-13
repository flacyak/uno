/**
 * @fileoverview A row index as a save writes it: each block's start as
 * unsigned LEB128 varints of its steps in rows and bytes from the last one's.
 */

import type { RowIndex } from './rows.ts';

/**
 * The scanner and block rule a saved index was made by, bumped when either
 * finds other blocks in the same bytes. tests/engine/saved.test.ts pins it.
 */
export const INDEX_VERSION = 1;

/** Starts is each block's first row and first byte, in order. */
export interface Starts {
  firsts: Float64Array<ArrayBuffer>;
  offsets: Float64Array<ArrayBuffer>;
}

/** What a varint byte holds of a value, and the bit set on all but its last. */
const VARINT_BASE = 0x80;
/** Each start is two steps: rows, then bytes. */
const STEPS = 2;

/** encodeBlocks writes the start of every block `index` has begun. */
export function encodeBlocks(index: RowIndex): Uint8Array {
  const out: number[] = [];
  const put = (step: number): void => {
    for (; step >= VARINT_BASE; step = Math.floor(step / VARINT_BASE)) {
      out.push((step % VARINT_BASE) + VARINT_BASE);
    }
    out.push(step);
  };
  let [row, byte] = [0, 0];
  for (let block = 0; block < index.begun; block++) {
    const [first] = index.rowsOf(block);
    const [offset] = index.bytesOf(block);
    put(first - row);
    put(offset - byte);
    [row, byte] = [first, offset];
  }
  return Uint8Array.from(out);
}

/**
 * decodeBlocks reads what `encodeBlocks` wrote. Undefined for bytes it could
 * not have: cut short, past 2^53, or a block no later than the one before.
 */
export function decodeBlocks(bytes: Uint8Array): Starts | undefined {
  const steps: number[] = [];
  let [step, scale] = [0, 1];
  for (const byte of bytes) {
    step += (byte % VARINT_BASE) * scale;
    scale *= VARINT_BASE;
    if (byte >= VARINT_BASE) continue;
    steps.push(step);
    [step, scale] = [0, 1];
  }
  if (scale !== 1 || steps.length % STEPS !== 0) return undefined;
  const firsts = new Float64Array(steps.length / STEPS);
  const offsets = new Float64Array(steps.length / STEPS);
  let [row, byte] = [0, 0];
  for (let block = 0; block < firsts.length; block++) {
    const [rows, bytesOn] = [steps[STEPS * block]!, steps[STEPS * block + 1]!];
    if (block > 0 && (rows === 0 || bytesOn === 0)) return undefined;
    [row, byte] = [row + rows, byte + bytesOn];
    [firsts[block], offsets[block]] = [row, byte];
  }
  if (byte > Number.MAX_SAFE_INTEGER) return undefined;
  return { firsts, offsets };
}
