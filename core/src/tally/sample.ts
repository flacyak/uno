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
// A page holds the least and most of this many blocks in 8 KB, so a fold of
// one block stays small, and one of every block holds 32 bytes a block.
const PAGE_BLOCKS = 256;

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
  /** The least and most x and y of every plotted row, 0 when none is. */
  least: Point;
  most: Point;
  /** Rows left out: unparsed when a cell holds a word, else blank. */
  skipped: Skipped;
}

/** The least and most x and y of the plotted rows of PAGE_BLOCKS blocks. */
class Page {
  readonly leastX = new Float64Array(PAGE_BLOCKS).fill(Infinity);
  readonly leastY = new Float64Array(PAGE_BLOCKS).fill(Infinity);
  readonly mostX = new Float64Array(PAGE_BLOCKS).fill(-Infinity);
  readonly mostY = new Float64Array(PAGE_BLOCKS).fill(-Infinity);

  /** extent returns block `at`'s least and most. */
  extent(at: number): [Point, Point] {
    const i = at % PAGE_BLOCKS;
    return [
      { x: this.leastX[i]!, y: this.leastY[i]! },
      { x: this.mostX[i]!, y: this.mostY[i]! },
    ];
  }

  /** widen moves block `at`'s least and most out over `least` and `most`. */
  widen(at: number, least: Point, most: Point): void {
    const i = at % PAGE_BLOCKS;
    this.leastX[i] = Math.min(this.leastX[i]!, least.x);
    this.leastY[i] = Math.min(this.leastY[i]!, least.y);
    this.mostX[i] = Math.max(this.mostX[i]!, most.x);
    this.mostY[i] = Math.max(this.mostY[i]!, most.y);
  }
}

/**
 * SampleFold keeps a scatter's points: those of the SCATTER_POINTS_AT_MOST
 * rows of least rowRank, which hangs on the row number alone, so blocks of
 * rows fold alone or in any order into the same sample. A row whose x or y
 * is not a number keeps its place in the sample, with no point. Beside it,
 * a fold counts every row it plots and every row it leaves out, and keeps
 * each block's least and most x and y, so a chart's axes take in every row.
 */
export class SampleFold {
  /** Each kept row's point, or undefined when the row is left out. */
  private readonly kept = new Map<number, Point | undefined>();
  /** The row ranked last when kept was last cut. No row past it is sampled. */
  private last: number | undefined;
  private plotted = 0;
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };
  /** Each block's least and most, by the first block of their page. */
  private readonly pages = new Map<number, Page>();

  /** add folds `row` of `block`, whose x cell is `xCell` and y `yCell`. */
  add(block: number, row: number, xCell: string, yCell: string): void {
    const point = this.count(xCell, yCell, 1);
    if (point !== undefined) this.page(block).widen(block, point, point);
    this.keep(row, point);
  }

  /**
   * remove takes back a row that add folded, so an edit can add the row's
   * new cells. Its block keeps its least and most, which may then be too wide.
   */
  remove(block: number, row: number, xCell: string, yCell: string): void {
    this.count(xCell, yCell, -1);
    this.kept.delete(row);
  }

  /** merge takes in what `other` folded, of rows this fold has not. */
  merge(other: SampleFold): void {
    this.plotted += other.plotted;
    this.skipped.blank += other.skipped.blank;
    this.skipped.unparsed += other.skipped.unparsed;
    for (const [row, point] of other.kept) this.keep(row, point);
    for (const [first, page] of other.pages) {
      const mine = this.page(first);
      for (let at = first; at < first + PAGE_BLOCKS; at++) {
        mine.widen(at, ...page.extent(at));
      }
    }
  }

  /** snapshot reads the fold as plain numbers. */
  snapshot(): Sample {
    const rows = [...this.kept.keys()].sort(byRank);
    const points = rows
      .slice(0, SCATTER_POINTS_AT_MOST)
      .flatMap((row) => this.kept.get(row) ?? []);
    const [least, most] = this.extent();
    const seen = this.plotted > 0;
    return {
      x: points.map((p) => p.x),
      y: points.map((p) => p.y),
      plotted: this.plotted,
      least: seen ? least : { x: 0, y: 0 },
      most: seen ? most : { x: 0, y: 0 },
      skipped: { ...this.skipped },
    };
  }

  /** extent returns the least and most x and y of every block. */
  private extent(): [Point, Point] {
    const least = { x: Infinity, y: Infinity };
    const most = { x: -Infinity, y: -Infinity };
    for (const page of this.pages.values()) {
      least.x = Math.min(least.x, ...page.leastX);
      least.y = Math.min(least.y, ...page.leastY);
      most.x = Math.max(most.x, ...page.mostX);
      most.y = Math.max(most.y, ...page.mostY);
    }
    return [least, most];
  }

  /** page returns the page that holds block `at`, made when it has none. */
  private page(at: number): Page {
    const first = at - (at % PAGE_BLOCKS);
    let page = this.pages.get(first);
    if (page === undefined) {
      page = new Page();
      this.pages.set(first, page);
    }
    return page;
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

  /** count counts a row, or takes one back when `sign` is -1. */
  private count(xCell: string, yCell: string, sign: 1 | -1): Point | undefined {
    const x = parse(xCell);
    const y = parse(yCell);
    if (x === undefined || y === undefined) {
      const word = (v: number | undefined, cell: string) =>
        v === undefined && cell !== '';
      const kind = word(x, xCell) || word(y, yCell) ? 'unparsed' : 'blank';
      this.skipped[kind] += sign;
      return undefined;
    }
    this.plotted += sign;
    return { x, y };
  }
}
