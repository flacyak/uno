/**
 * @fileoverview A scatter's points, from a sample of rows chosen by number.
 */

import { parse } from '@num';

import { byRank } from './rank.ts';

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
}

/**
 * SampleFold keeps a scatter's points: those of the SCATTER_POINTS_AT_MOST
 * rows of least rowRank, which hangs on the row number alone. A row whose x
 * or y is not a number keeps its place in the sample, with no point.
 */
export class SampleFold {
  /** Each kept row's point, or undefined when the row is left out. */
  private readonly kept = new Map<number, Point | undefined>();
  /** The row ranked last when kept was last cut. No row past it is sampled. */
  private last: number | undefined;

  /** add folds `row`, whose x cell is `xCell` and y cell `yCell`. */
  add(row: number, xCell: string, yCell: string): void {
    const x = parse(xCell);
    const y = parse(yCell);
    this.keep(row, x === undefined || y === undefined ? undefined : { x, y });
  }

  /** snapshot reads the fold as plain numbers. */
  snapshot(): Sample {
    const rows = [...this.kept.keys()].sort(byRank);
    const points = rows
      .slice(0, SCATTER_POINTS_AT_MOST)
      .flatMap((row) => this.kept.get(row) ?? []);
    return { x: points.map((p) => p.x), y: points.map((p) => p.y) };
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
}
