/**
 * @fileoverview A scatter's points, from a sample of rows chosen by number.
 */

import { parse } from '@num';

import { byRank } from './rank.ts';
import type { Skipped } from './skipped.ts';

/**
 * SCATTER_POINTS_AT_MOST is how many rows a sample keeps, enough points that
 * where they crowd reads as density. As doubles they come to 64 KB.
 */
export const SCATTER_POINTS_AT_MOST = 4_096;
// A fold keeps twice the sample before it lets go of the rows ranked past
// it, so each sort of the kept rows is spread over a sample's worth of adds.
const KEPT_AT_MOST = 2 * SCATTER_POINTS_AT_MOST;

/** A row's x and y, both numbers. */
export interface Point {
  x: number;
  y: number;
}

/** What a fold holds, read. */
export interface Sample {
  /** At most SCATTER_POINTS_AT_MOST, in rank order: point i is x[i], y[i]. */
  x: number[];
  y: number[];
  /** The rows whose x and y both read as numbers, sampled or not. */
  plotted: number;
  /** Rows left out: unparsed when a cell holds a word, else blank. */
  skipped: Skipped;
}

/**
 * SampleFold keeps a scatter's points: those of the SCATTER_POINTS_AT_MOST
 * rows of least rowRank, which hangs on the row number alone, so blocks of
 * rows fold alone or in any order into the same sample. A row whose x or y
 * is not a number keeps its place in the sample, with no point. Beside it,
 * a fold counts every row it plots and every row it leaves out.
 */
export class SampleFold {
  /** Each kept row's point, or undefined when the row is left out. */
  private readonly kept = new Map<number, Point | undefined>();
  /** The row ranked last when kept was last cut. No row past it is sampled. */
  private last: number | undefined;
  private plotted = 0;
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };

  /** add folds `row`, whose x cell is `xCell` and y cell `yCell`. */
  add(row: number, xCell: string, yCell: string): void {
    this.keep(row, this.count(xCell, yCell));
  }

  /** merge takes in what `other` folded, of rows this fold has not. */
  merge(other: SampleFold): void {
    this.plotted += other.plotted;
    this.skipped.blank += other.skipped.blank;
    this.skipped.unparsed += other.skipped.unparsed;
    for (const [row, point] of other.kept) this.keep(row, point);
  }

  /** snapshot reads the fold as plain numbers. */
  snapshot(): Sample {
    const rows = [...this.kept.keys()].sort(byRank);
    const points = rows
      .slice(0, SCATTER_POINTS_AT_MOST)
      .flatMap((row) => this.kept.get(row) ?? []);
    return {
      x: points.map((p) => p.x),
      y: points.map((p) => p.y),
      plotted: this.plotted,
      skipped: { ...this.skipped },
    };
  }

  /** keep holds a row's point, unless the row ranks past the sample. */
  private keep(row: number, point: Point | undefined): void {
    if (this.last !== undefined && byRank(row, this.last) > 0) return;
    this.kept.set(row, point);
    if (this.kept.size <= KEPT_AT_MOST) return;
    const rows = [...this.kept.keys()].sort(byRank);
    for (const past of rows.slice(SCATTER_POINTS_AT_MOST)) {
      this.kept.delete(past);
    }
    this.last = rows[SCATTER_POINTS_AT_MOST - 1];
  }

  /** count counts a row, and returns its point when it has one. */
  private count(xCell: string, yCell: string): Point | undefined {
    const x = parse(xCell);
    const y = parse(yCell);
    if (x === undefined || y === undefined) {
      const word = (v: number | undefined, cell: string) =>
        v === undefined && cell !== '';
      this.skipped[word(x, xCell) || word(y, yCell) ? 'unparsed' : 'blank']++;
      return undefined;
    }
    this.plotted++;
    return { x, y };
  }
}
