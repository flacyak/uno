/**
 * @fileoverview A sample of rows chosen by number, with their numbers.
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

/** Sample of any number of columns, with a number of each in place of x and y. */
export interface Sampled extends Omit<Sample, 'x' | 'y' | 'least' | 'most'> {
  values: number[][];
  least: number[];
  most: number[];
}

/** What a scatter's fold holds, read. */
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

/** SavedSample of any number of columns, with a number of each in place of x and y. */
export interface SavedSampled extends Omit<
  SavedSample,
  'marks' | 'kept' | 'pages'
> {
  marks: Mark[];
  kept: number[][];
  pages: Array<{
    first: number;
    span: number;
    least: number[];
    most: number[];
  }>;
}

/** The least and most of each column over the plotted rows of PAGE_BLOCKS blocks. */
class Page {
  /**
   * How many of the first blocks hold the least and most of them all, as a
   * save kept them, until an edit takes one and each folds again.
   */
  coarse = 0;

  /** Each column's least and most, by block. */
  readonly least: Float64Array[];
  readonly most: Float64Array[];

  constructor(columns: number) {
    const each = (v: number) =>
      Array.from({ length: columns }, () =>
        new Float64Array(PAGE_BLOCKS).fill(v),
      );
    this.least = each(Infinity);
    this.most = each(-Infinity);
  }

  /** extent returns block `at`'s least and most. */
  extent(at: number): [number[], number[]] {
    const i = at % PAGE_BLOCKS;
    return [this.least.map((c) => c[i]!), this.most.map((c) => c[i]!)];
  }

  /** widen moves block `at`'s least and most out over `least` and `most`. */
  widen(at: number, least: readonly number[], most: readonly number[]): void {
    const i = at % PAGE_BLOCKS;
    this.least.forEach((c, k) => (c[i] = Math.min(c[i]!, least[k]!)));
    this.most.forEach((c, k) => (c[i] = Math.max(c[i]!, most[k]!)));
  }

  /** set puts block `at`'s least and most at `least` and `most`. */
  set(at: number, least: readonly number[], most: readonly number[]): void {
    const i = at % PAGE_BLOCKS;
    this.least.forEach((c, k) => (c[i] = least[k]!));
    this.most.forEach((c, k) => (c[i] = most[k]!));
  }

  /** touches reports whether `p` sits on block `at`'s least or most. */
  touches(at: number, p: readonly number[]): boolean {
    const [least, most] = this.extent(at);
    return p.some((v, k) => v === least[k] || v === most[k]);
  }
}

/**
 * SampleFold keeps the numbers of any number of columns, a scatter's x and y
 * among them, of the SCATTER_POINTS_AT_MOST
 * rows of least rowRank, which hangs on the row number alone, so blocks of
 * rows fold alone or in any order into the same sample. A row with a cell
 * that is not a number keeps its place in the sample, with none. Beside it,
 * a fold counts every row it plots and every row it leaves out, and keeps
 * each block's least and most of each column, so a chart's axes take in every row.
 * It reads column k with the decimal mark `marks[k]`.
 */
export class SampleFold {
  readonly marks: readonly Mark[];
  /** Each kept row's numbers, or undefined when the row is left out. */
  private readonly kept = new Map<number, number[] | undefined>();
  /** The row ranked last when kept was last cut. No row past it is sampled. */
  private last: number | undefined;
  private plotted = 0;
  private readonly skipped: Skipped = { blank: 0, unparsed: 0 };
  /** Each block's least and most, by the first block of their page. */
  private readonly pages = new Map<number, Page>();
  /** The blocks whose least or most an edit took back. */
  private readonly stales = new Set<number>();

  constructor(marks: readonly Mark[]) {
    this.marks = [...marks];
  }

  /** add folds `row` of `block`, whose cells are `cells`, a column each. */
  add(block: number, row: number, ...cells: string[]): void {
    const values = this.count(cells, 1);
    if (values !== undefined) this.page(block).widen(block, values, values);
    this.keep(row, values);
  }

  /**
   * remove takes back a row that add folded, so an edit can add the row's
   * new cells. A row on its block's least or most leaves the block stale.
   */
  remove(block: number, row: number, ...cells: string[]): void {
    const values = this.count(cells, -1);
    const page = this.page(block);
    if (values !== undefined && page.touches(block, values)) {
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
  forget(row: number, ...cells: string[]): void {
    this.count(cells, -1);
    this.kept.delete(row);
  }

  /** merge takes in what `other` folded, of rows this fold has not. */
  merge(other: SampleFold): void {
    this.plotted += other.plotted;
    this.skipped.blank += other.skipped.blank;
    this.skipped.unparsed += other.skipped.unparsed;
    for (const [row, values] of other.kept) this.keep(row, values);
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
  saved(): SavedSampled {
    const kept = [...this.kept].map(([row, v]) =>
      v === undefined ? [row] : [row, ...v],
    );
    const pages = [...this.pages].flatMap(([first, page]) => {
      const [least, most] = extentOf([page], this.marks.length);
      const [leastOf, mostOf] = [page.least[0]!, page.most[0]!];
      const span = 1 + leastOf.findLastIndex((v, i) => v <= mostOf[i]!);
      return least[0]! <= most[0]! ? [{ first, span, least, most }] : [];
    });
    const { last, plotted } = this;
    const skipped = { ...this.skipped };
    const counts = { last, plotted, skipped, stale: this.stale() };
    return { marks: [...this.marks], kept, ...counts, pages };
  }

  /**
   * restored is the fold `saved` holds, or undefined where it holds none.
   * Each block of a page holds the page's least and most, so the page is
   * coarse: an edit that takes its least or most folds each block again.
   */
  static restored(saved: unknown): SampleFold | undefined {
    if (!isRecord(saved) || !Array.isArray(saved['marks'])) return undefined;
    const marks: unknown[] = saved['marks'];
    const { kept, last, plotted, stale, pages } = saved;
    const skipped = restoredSkipped(saved['skipped']);
    if (marks.length === 0 || !marks.every(isMark) || skipped === undefined)
      return undefined;
    if (!isCount(plotted) || !(last === undefined || isCount(last)))
      return undefined;
    if (!Array.isArray(kept) || kept.length > KEPT_AT_MOST) return undefined;
    const columns = marks.length;
    if (!kept.every((k) => isKept(k, columns))) return undefined;
    if (!Array.isArray(stale) || !stale.every(isCount)) return undefined;
    if (!Array.isArray(pages) || !pages.every((p) => isPage(p, columns)))
      return undefined;
    const fold = new SampleFold(marks);
    for (const [row, ...v] of kept)
      fold.kept.set(row, v.length > 0 ? v : undefined);
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
  snapshot(): Sampled {
    const rows = [...this.kept.keys()].sort(byRank);
    const values = rows.slice(0, SCATTER_POINTS_AT_MOST).flatMap((row) => {
      const v = this.kept.get(row);
      return v === undefined ? [] : [[...v]];
    });
    const [least, most] = this.extent();
    const none = this.marks.map(() => 0);
    const seen = this.plotted > 0;
    return {
      values,
      plotted: this.plotted,
      least: seen ? least : none,
      most: seen ? most : none,
      skipped: { ...this.skipped },
    };
  }

  /** extent returns the least and most of each column over every block. */
  private extent(): [number[], number[]] {
    return extentOf(this.pages.values(), this.marks.length);
  }

  /** page returns the page that holds block `at`, made when it has none. */
  private page(at: number): Page {
    const first = at - (at % PAGE_BLOCKS);
    let page = this.pages.get(first);
    if (page === undefined) {
      page = new Page(this.marks.length);
      this.pages.set(first, page);
    }
    return page;
  }

  /** keep holds a row's numbers, unless the row ranks past the sample. */
  private keep(row: number, values: number[] | undefined): void {
    if (this.last !== undefined && byRank(row, this.last) > 0) return;
    this.kept.set(row, values);
    if (this.kept.size <= KEPT_AT_MOST) return;
    const rows = [...this.kept.keys()].sort(byRank);
    for (const past of rows.slice(SCATTER_POINTS_AT_MOST)) {
      this.kept.delete(past);
    }
    this.last = rows[SCATTER_POINTS_AT_MOST - 1];
  }

  /** count counts a row, or takes one back when `sign` is -1. */
  private count(cells: readonly string[], sign: 1 | -1): number[] | undefined {
    const values = this.marks.map((mark, k) => parse(cells[k] ?? '', mark));
    if (values.every((v) => v !== undefined)) {
      this.plotted += sign;
      return values;
    }
    const word = values.some((v, k) => v === undefined && cells[k] !== '');
    this.skipped[word ? 'unparsed' : 'blank'] += sign;
    return undefined;
  }
}

/** extentOf returns each column's least and most over every block of `pages`. */
function extentOf(
  pages: Iterable<Page>,
  columns: number,
): [number[], number[]] {
  const least = Array<number>(columns).fill(Infinity);
  const most = Array<number>(columns).fill(-Infinity);
  for (const page of pages) {
    page.least.forEach((c, k) => (least[k] = Math.min(least[k]!, ...c)));
    page.most.forEach((c, k) => (most[k] = Math.max(most[k]!, ...c)));
  }
  return [least, most];
}

/** isKept says whether `v` is a kept row of `columns` as a save writes it. */
function isKept(v: unknown, columns: number): v is number[] {
  if (!Array.isArray(v) || !isCount(v[0])) return false;
  const values: unknown[] = v.slice(1);
  return v.length === 1 || (values.length === columns && isNumbers(values));
}

/** isPage says whether `v` is a page's least and most as a save writes it. */
function isPage(
  v: unknown,
  columns: number,
): v is SavedSampled['pages'][number] {
  if (!isRecord(v)) return false;
  const { first, span, least, most } = v;
  if (!isNumbers(least) || !isNumbers(most)) return false;
  if (least.length !== columns || most.length !== columns) return false;
  const inPage = isCount(span) && span > 0 && span <= PAGE_BLOCKS;
  const ordered = least.every((l, k) => l <= most[k]!);
  return isCount(first) && first % PAGE_BLOCKS === 0 && inPage && ordered;
}

/** isNumbers says whether `v` is a list of finite numbers. */
function isNumbers(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => Number.isFinite(n));
}

/** pointOf is the point of a scatter's x and y. */
function pointOf([x, y]: readonly number[]): Point {
  return { x: x!, y: y! };
}

/** pointsOf reads a fold of a scatter's x and y as its points. */
export function pointsOf(sampled: Sampled): Sample {
  const { values, plotted, skipped } = sampled;
  return {
    x: values.map((v) => v[0]!),
    y: values.map((v) => v[1]!),
    plotted,
    least: pointOf(sampled.least),
    most: pointOf(sampled.most),
    skipped,
  };
}

/** savedPoints is the save of a fold of a scatter's x and y, as a scatter's save writes it. */
export function savedPoints(saved: SavedSampled): SavedSample {
  const [x, y] = saved.marks;
  const pages = saved.pages.map((p) => ({
    ...p,
    least: pointOf(p.least),
    most: pointOf(p.most),
  }));
  const kept = saved.kept as SavedSample['kept'];
  return { ...saved, marks: { x: x!, y: y! }, kept, pages };
}

/** restoredPoints is the fold of a scatter's x and y that `saved` holds, or undefined where it holds none. */
export function restoredPoints(saved: unknown): SampleFold | undefined {
  const pair = (p: unknown) => (isRecord(p) ? [p['x'], p['y']] : undefined);
  if (!isRecord(saved) || !Array.isArray(saved['pages'])) return undefined;
  const pages: unknown[] = saved['pages'];
  const paired = pages.map((p) =>
    isRecord(p) ? { ...p, least: pair(p['least']), most: pair(p['most']) } : p,
  );
  return SampleFold.restored({
    ...saved,
    marks: pair(saved['marks']),
    pages: paired,
  });
}
