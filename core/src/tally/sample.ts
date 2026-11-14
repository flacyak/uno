/**
 * @fileoverview A scatter's points, from a sample of rows chosen by number.
 */

import type { Mark } from '@num';
import { parse } from '@num';

import { byRank } from './rank.ts';
import { isCount, isMark, isRecord } from './saved.ts';
import { restoredSkipped } from './skipped.ts';
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

/** The decimal marks of a scatter's x and y columns. */
export interface Marks {
  x: Mark;
  y: Mark;
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

/**
 * SavedSample is what a save keeps of a SampleFold: its marks, each kept
 * row as [row, x, y], or [row] where it has no point, the row ranked last
 * at the last cut, its counts, the blocks an edit left stale, and the least
 * and most of each page over the first `span` of its blocks. A -0 reads
 * back as 0.
 */
export interface SavedSample {
  marks: Marks;
  kept: Array<[number, number, number] | [number]>;
  last?: number;
  plotted: number;
  skipped: Skipped;
  stale: number[];
  pages: Array<{ first: number; span: number; least: Point; most: Point }>;
}

/** The least and most x and y of the plotted rows of PAGE_BLOCKS blocks. */
class Page {
  /**
   * How many of the first blocks hold the least and most of them all, as a
   * save kept them, until an edit takes one and each folds again.
   */
  coarse = 0;

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

  /** set puts block `at`'s least and most at `least` and `most`. */
  set(at: number, least: Point, most: Point): void {
    const i = at % PAGE_BLOCKS;
    this.leastX[i] = least.x;
    this.leastY[i] = least.y;
    this.mostX[i] = most.x;
    this.mostY[i] = most.y;
  }

  /** touches reports whether `p` sits on block `at`'s least or most. */
  touches(at: number, p: Point): boolean {
    const [least, most] = this.extent(at);
    const onX = p.x === least.x || p.x === most.x;
    return onX || p.y === least.y || p.y === most.y;
  }
}

/**
 * SampleFold keeps a scatter's points: those of the SCATTER_POINTS_AT_MOST
 * rows of least rowRank, which hangs on the row number alone, so blocks of
 * rows fold alone or in any order into the same sample. A row whose x or y
 * is not a number keeps its place in the sample, with no point. Beside it,
 * a fold counts every row it plots and every row it leaves out, and keeps
 * each block's least and most x and y, so a chart's axes take in every row.
 * It reads x and y with the decimal marks of their columns, `marks`.
 */
export class SampleFold {
  readonly marks: Marks;
  /** Each kept row's point, or undefined when the row is left out. */
  private readonly kept = new Map<number, Point | undefined>();
  /** The row ranked last when kept was last cut. No row past it is sampled. */
  private last: number | undefined;
  private plotted = 0;
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };
  /** Each block's least and most, by the first block of their page. */
  private readonly pages = new Map<number, Page>();
  /** The blocks whose least or most an edit took back. */
  private readonly stales = new Set<number>();

  constructor(marks: Marks) {
    this.marks = marks;
  }

  /** add folds `row` of `block`, whose x cell is `xCell` and y `yCell`. */
  add(block: number, row: number, xCell: string, yCell: string): void {
    const point = this.count(xCell, yCell, 1);
    if (point !== undefined) this.page(block).widen(block, point, point);
    this.keep(row, point);
  }

  /**
   * remove takes back a row that add folded, so an edit can add the row's
   * new cells. A row on its block's least or most leaves the block stale.
   */
  remove(block: number, row: number, xCell: string, yCell: string): void {
    const point = this.count(xCell, yCell, -1);
    const page = this.page(block);
    if (point !== undefined && page.touches(block, point)) {
      this.stales.add(block);
      // A block of a coarse page holds the page's least and most, which
      // only every block of it folded again tells apart.
      const first = block - (block % PAGE_BLOCKS);
      if (block < first + page.coarse) {
        for (let b = first; b < first + page.coarse; b++) this.stales.add(b);
        page.coarse = 0;
      }
    }
    this.kept.delete(row);
  }

  /**
   * forget takes back a row as remove does, for a block that refold empties
   * and that folds again whole, so it leaves no block stale.
   */
  forget(row: number, xCell: string, yCell: string): void {
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
    for (const block of other.stales) this.stales.add(block);
  }

  /** refold mends stale `block` from `alone`, a fold of its rows alone. */
  refold(block: number, alone: SampleFold): void {
    this.page(block).set(block, ...alone.extent());
    this.stales.delete(block);
  }

  /** stale lists the blocks whose least and most an edit may leave too wide. */
  stale(): number[] {
    return [...this.stales].sort((a, b) => a - b);
  }

  /** saved is what the fold holds, with each page's least and most. */
  saved(): SavedSample {
    const kept = [...this.kept].map(([row, p]): SavedSample['kept'][number] =>
      p === undefined ? [row] : [row, p.x, p.y],
    );
    const pages = [...this.pages].flatMap(([first, page]) => {
      const [least, most] = extentOf([page]);
      const span = 1 + page.leastX.findLastIndex((x, i) => x <= page.mostX[i]!);
      return least.x <= most.x ? [{ first, span, least, most }] : [];
    });
    const { last, plotted } = this;
    const skipped = { ...this.skipped };
    const counts = { last, plotted, skipped, stale: this.stale() };
    return { marks: { ...this.marks }, kept, ...counts, pages };
  }

  /**
   * restored is the fold `saved` holds, or undefined where it holds none.
   * Each block of a page holds the page's least and most, so the page is
   * coarse: an edit that takes its least or most folds each block again.
   */
  static restored(saved: unknown): SampleFold | undefined {
    if (!isRecord(saved) || !isRecord(saved['marks'])) return undefined;
    const { x, y } = saved['marks'];
    const { kept, last, plotted, stale, pages } = saved;
    const skipped = restoredSkipped(saved['skipped']);
    if (!isMark(x) || !isMark(y) || skipped === undefined) return undefined;
    if (!isCount(plotted) || !(last === undefined || isCount(last)))
      return undefined;
    if (!Array.isArray(kept) || kept.length > KEPT_AT_MOST) return undefined;
    if (!kept.every(isKept) || !Array.isArray(stale) || !stale.every(isCount))
      return undefined;
    if (!Array.isArray(pages) || !pages.every(isPage)) return undefined;
    const fold = new SampleFold({ x, y });
    for (const k of kept)
      fold.kept.set(k[0], k.length === 3 ? { x: k[1], y: k[2] } : undefined);
    fold.last = last;
    fold.plotted = plotted;
    Object.assign(fold.skipped, skipped);
    for (const block of stale) fold.stales.add(block);
    for (const { first, span, least, most } of pages) {
      const page = fold.page(first);
      for (let b = first; b < first + span; b++) page.set(b, least, most);
      page.coarse = span;
    }
    return fold;
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
    return extentOf(this.pages.values());
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
    const x = parse(xCell, this.marks.x);
    const y = parse(yCell, this.marks.y);
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

/** extentOf returns the least and most x and y of every block of `pages`. */
function extentOf(pages: Iterable<Page>): [Point, Point] {
  const least = { x: Infinity, y: Infinity };
  const most = { x: -Infinity, y: -Infinity };
  for (const page of pages) {
    least.x = Math.min(least.x, ...page.leastX);
    least.y = Math.min(least.y, ...page.leastY);
    most.x = Math.max(most.x, ...page.mostX);
    most.y = Math.max(most.y, ...page.mostY);
  }
  return [least, most];
}

/** isKept says whether `v` is a kept row as a save writes it. */
function isKept(v: unknown): v is SavedSample['kept'][number] {
  if (!Array.isArray(v) || !isCount(v[0])) return false;
  return v.length === 1 || (v.length === 3 && isPoint({ x: v[1], y: v[2] }));
}

/** isPage says whether `v` is a page's least and most as a save writes it. */
function isPage(v: unknown): v is SavedSample['pages'][number] {
  if (!isRecord(v)) return false;
  const { first, span, least, most } = v;
  if (!isPoint(least) || !isPoint(most)) return false;
  const inPage = isCount(span) && span > 0 && span <= PAGE_BLOCKS;
  const ordered = least.x <= most.x && least.y <= most.y;
  return isCount(first) && first % PAGE_BLOCKS === 0 && inPage && ordered;
}

/** isPoint says whether `v` is a point of two finite numbers. */
function isPoint(v: unknown): v is Point {
  return isRecord(v) && Number.isFinite(v['x']) && Number.isFinite(v['y']);
}
