/**
 * @fileoverview A number column's rows counted per number, for the charts
 * that draw how its numbers spread.
 */

import type { Mark } from '@num';
import { parse } from '@num';

import { ExactSum } from './exact.ts';
import type { Skipped } from './skipped.ts';

/** One bucket: the rows whose number is from `low` up to `high`, the number itself when exact. */
export interface Bucket {
  low: number;
  high: number;
  rows: number;
}

/** What a spread holds, read. */
export interface Spreading {
  /** The buckets that hold a row, least first. */
  buckets: Bucket[];
  /** The rows whose cell reads as a number. */
  numbers: number;
  /** Their sum, rounded once. */
  sum: number;
  /** The cells that are blank or read as no number. */
  skipped: Skipped;
}

/**
 * SpreadFold counts a number column's rows per number, and sums them
 * exactly for a mean. Rows are added and taken back one at a time, so an
 * edit moves a fold by the row it changed. A cell that reads as no number
 * is counted as left out.
 */
export class SpreadFold {
  /** The mark cells are read with. */
  readonly mark: Mark;
  /** Rows by number. A Map counts -0 as 0. */
  private readonly buckets = new Map<number, number>();
  private numbers = 0;
  private readonly sum = new ExactSum();
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  constructor(mark: Mark) {
    this.mark = mark;
  }

  /** add counts a row whose cell is `cell`. */
  add(cell: string): void {
    this.count(cell, 1);
  }

  /** remove takes back a row that add counted, and an empty bucket with it. */
  remove(cell: string): void {
    this.count(cell, -1);
  }

  /** read is what the fold holds, as plain numbers. */
  read(): Spreading {
    const buckets = [...this.buckets]
      .map(([x, rows]) => ({ low: x, high: x, rows }))
      .sort((a, b) => a.low - b.low);
    return {
      buckets,
      numbers: this.numbers,
      sum: this.sum.value(),
      skipped: { ...this.skipped },
    };
  }

  /** count adds a row whose cell is `cell`, or takes one back when `sign` is -1. */
  private count(cell: string, sign: 1 | -1): void {
    const x = parse(cell, this.mark);
    if (x === undefined) {
      if (cell === '') this.skipped.blank += sign;
      else this.skipped.unparsed += sign;
      return;
    }
    this.numbers += sign;
    this.sum.add(sign * x);
    const rows = (this.buckets.get(x) ?? 0) + sign;
    if (rows === 0) this.buckets.delete(x);
    else this.buckets.set(x, rows);
  }
}
