/**
 * @fileoverview A number column's rows counted per number, for the charts
 * that draw how its numbers spread.
 */

import type { Mark } from '@num';
import { parse } from '@num';

import { ExactSum } from './exact.ts';
import type { SavedSum } from './exact.ts';
import { boundsOf, coarser, isKey, keyOf } from './figures.ts';
import { isCount, isMark, isRecord } from './saved.ts';
import { restoredSkipped } from './skipped.ts';
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
 * SavedSpread is every bit of a SpreadFold, as a save writes it: the mark it
 * reads with, the figures it holds, each bucket's key and rows in the order
 * they began, and its sum and what it left out.
 */
export interface SavedSpread {
  mark: Mark;
  figures: Figures;
  buckets: Array<[number, number]>;
  sum: SavedSum;
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
  private sum = new ExactSum();
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

  /** saved is what the fold holds, which `restored` reads back as it was. */
  saved(): SavedSpread {
    return {
      mark: this.mark,
      figures: this.figures,
      buckets: [...this.buckets],
      sum: this.sum.saved(),
      skipped: { ...this.skipped },
    };
  }

  /**
   * restored is the fold `saved` holds, bound to `atMost` buckets, or
   * undefined where it holds none: a field out of range, a key twice or not
   * one its figures make, an empty bucket, or more than `atMost` buckets
   * above one figure.
   */
  static restored(
    saved: unknown,
    atMost = SPREAD_AT_MOST,
  ): SpreadFold | undefined {
    if (!isRecord(saved)) return undefined;
    const { mark, figures, buckets } = saved;
    const sum = ExactSum.restored(saved['sum']);
    const skipped = restoredSkipped(saved['skipped']);
    const coarse = isCount(figures) && figures >= 1;
    const f =
      figures === 'exact' || (coarse && figures <= FIGURES_AT_MOST)
        ? figures
        : undefined;
    const fields =
      isMark(mark) &&
      f !== undefined &&
      sum !== undefined &&
      skipped !== undefined &&
      Array.isArray(buckets) &&
      (buckets.length <= atMost || f === 1);
    if (!fields) return undefined;
    const fold = new SpreadFold(mark, atMost);
    const isHeld = (key: unknown): key is number =>
      typeof key === 'number' &&
      (f === 'exact' ? Number.isFinite(key) : isKey(key, f));
    for (const b of buckets as unknown[]) {
      const [key, count]: unknown[] = Array.isArray(b) ? b : [];
      if (!isHeld(key) || fold.buckets.has(key)) return undefined;
      if (!isCount(count) || count === 0) return undefined;
      fold.buckets.set(key, count);
      fold.numbers += count;
    }
    fold.figures = f;
    fold.sum = sum;
    Object.assign(fold.skipped, skipped);
    return fold;
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
