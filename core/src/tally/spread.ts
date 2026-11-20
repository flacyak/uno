/**
 * @fileoverview A number column's rows counted per number, for the charts
 * that draw how its numbers spread.
 */

import type { Mark } from '@num';
import { parse } from '@num';

import { ExactSum } from './exact.ts';
import { boundsOf, coarser, keyOf } from './figures.ts';
import type { Skipped } from './skipped.ts';

/** The most buckets a spread holds before it keeps fewer significant figures. */
export const SPREAD_AT_MOST = 8_192;
/** The most significant figures a bucket keeps once a spread stops being exact. */
export const FIGURES_AT_MOST = 12;
/** Whether a spread holds each number, or how many significant figures of it. */
export type Figures = number | 'exact';

/** One bucket: the rows whose number is from `low` up to `high`, the number itself when exact. */
export interface Bucket {
  low: number;
  high: number;
  rows: number;
}

/** What a spread holds, read. */
export interface Spreading {
  /** 'exact', or the significant figures every bucket keeps. */
  figures: Figures;
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
 * is counted as left out. It holds each number while there are at most
 * `atMost` of them, then the FIGURES_AT_MOST leading figures of each, then
 * one fewer each time the buckets pass `atMost` again, down to one. A
 * coarser bucket is the union of finer ones, so every count stays exact, and
 * it never goes back to finer ones.
 */
export class SpreadFold {
  /** The mark cells are read with. */
  readonly mark: Mark;
  private readonly atMost: number;
  private figures: Figures = 'exact';
  /** Rows by number while exact, else by key. A Map counts -0 as 0. */
  private readonly buckets = new Map<number, number>();
  private numbers = 0;
  private readonly sum = new ExactSum();
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  constructor(mark: Mark, atMost = SPREAD_AT_MOST) {
    this.mark = mark;
    this.atMost = atMost;
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
    const f = this.figures;
    const buckets = [...this.buckets]
      .sort(([a], [b]) => a - b)
      .map(([key, rows]) => {
        const [low, high] = f === 'exact' ? [key, key] : boundsOf(key, f);
        return { low, high, rows };
      });
    return {
      figures: f,
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
    const f = this.figures;
    const key = f === 'exact' ? x : keyOf(x, f);
    const rows = (this.buckets.get(key) ?? 0) + sign;
    if (rows === 0) this.buckets.delete(key);
    else this.buckets.set(key, rows);
    while (this.buckets.size > this.atMost && this.figures !== 1) {
      this.coarsen();
    }
  }

  /** coarsen merges every bucket into the one that holds it at a figure fewer. */
  private coarsen(): void {
    const finer = [...this.buckets];
    const f = this.figures;
    const into = f === 'exact' ? FIGURES_AT_MOST : f - 1;
    this.figures = into;
    this.buckets.clear();
    for (const [key, rows] of finer) {
      const to = f === 'exact' ? keyOf(key, into) : coarser(key, f);
      this.buckets.set(to, (this.buckets.get(to) ?? 0) + rows);
    }
  }
}
