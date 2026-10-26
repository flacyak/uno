/**
 * @fileoverview A row's rank, which orders a file's rows as a shuffle would.
 */

// splitmix32: the row stepped by 2^32 over the golden ratio, then mixed by a
// finalizer from Wellons' hash prospector. Every step can be undone, so no
// two rows below 2^32 share a rank.
const GOLDEN_GAMMA = 0x9e3779b9;
const MIX_FIRST = 0x21f0aaad;
const MIX_SECOND = 0x735a2d97;
const SHIFT_FIRST = 16;
const SHIFT_LATER = 15;

/** rowRank is a fixed hash of `row`, the same on every run. */
export function rowRank(row: number): number {
  let h = (row + GOLDEN_GAMMA) | 0;
  h = Math.imul(h ^ (h >>> SHIFT_FIRST), MIX_FIRST);
  h = Math.imul(h ^ (h >>> SHIFT_LATER), MIX_SECOND);
  return (h ^ (h >>> SHIFT_LATER)) >>> 0;
}

/** byRank orders rows by rank, and two rows of one rank by number. */
export function byRank(a: number, b: number): number {
  return rowRank(a) - rowRank(b) || a - b;
}
