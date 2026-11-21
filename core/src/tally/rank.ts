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

/**
 * Ranked keeps the `atMost` rows of least rank, each with what it holds, or
 * none. Blocks of rows keep alone or in any order the same rows. It keeps
 * twice that before it lets go of the rows ranked past them, so each sort of
 * the kept rows is spread over `atMost` keeps.
 */
export class Ranked<T> {
  readonly atMost: number;
  /** The row ranked last at the last cut. No row past it is kept. */
  last: number | undefined;
  private readonly rows = new Map<number, T | undefined>();

  constructor(atMost: number) {
    this.atMost = atMost;
  }

  /** The rows it keeps, ranked or not. */
  get size(): number {
    return this.rows.size;
  }

  /** keep keeps `row`, holding `held`, unless it ranks past the rows kept. */
  keep(row: number, held: T | undefined): void {
    if (this.last !== undefined && byRank(row, this.last) > 0) return;
    this.rows.set(row, held);
    if (this.rows.size <= 2 * this.atMost) return;
    const rows = [...this.rows.keys()].sort(byRank);
    for (const past of rows.slice(this.atMost)) this.rows.delete(past);
    this.last = rows[this.atMost - 1];
  }

  /** delete lets go of `row`. */
  delete(row: number): void {
    this.rows.delete(row);
  }

  /** kept gives each row it keeps and what it holds, in the order kept. */
  kept(): Array<[number, T | undefined]> {
    return [...this.rows];
  }

  /** first gives the first `atMost` rows by rank that hold something, and what. */
  first(): Array<[number, T]> {
    const rows = [...this.rows.keys()].sort(byRank).slice(0, this.atMost);
    return rows.flatMap((row) => {
      const held = this.rows.get(row);
      return held === undefined ? [] : [[row, held] as [number, T]];
    });
  }
}
