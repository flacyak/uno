/**
 * @fileoverview A view's charts, each folded over the rows read so far.
 *
 * A pass over the view's blocks feeds every chart in order, so a chart's
 * fold holds every row before the first block it lacks, an edit moves a
 * fold by the one row it changed, and an append takes over the folds of
 * the rows it kept. A chart reads the columns its plot names, found again
 * by header where the file moved them, with each column's decimal mark.
 */

import type { Chart, ChartColumn, Plot } from '@document';
import type { Mark } from '@num';
import type { Said } from '@said';
import { GroupsFold, SampleFold, isCount, isRecord } from '@tally';
import type { SavedGroups, SavedSample } from '@tally';
import type { Tally } from './protocol.ts';

/** How far one chart's fold has got. */
interface Folding {
  /** The plot the fold reads, which its tally names. */
  plot: Plot;
  /** Which fold the plot's columns make, so a like chart can keep it. */
  key: string;
  /** Rows folded: every row before the first block it lacks. */
  rows: number;
  /**
   * Rows folded ahead of `rows`, as [from, end): the blocks the index
   * completed while the pass behind them was still reading, which join
   * `rows` once it reaches them.
   */
  ahead: [number, number] | undefined;
  /**
   * Whether the chart has heard its last tally: the complete one, or that
   * its source could not be read.
   */
  done: boolean;
}

/**
 * One chart's fold, over the plot's columns where the view's headers put
 * them: a sample of `x` against `y`, or groups by one column, summing
 * another where the plot names one.
 */
type Tallying =
  | (Folding & { t: 'sample'; fold: SampleFold; x: number; y: number })
  | (Folding & { t: 'groups'; fold: GroupsFold; by: number; sum?: number });

/**
 * SavedChart is what a save keeps of a chart's fold: which fold its columns
 * make, the rows it holds, and the fold, with the marks it read them with.
 */
export interface SavedChart {
  key: string;
  rows: number;
  ahead?: [number, number];
  fold: SavedGroups | SavedSample;
}

/**
 * A block's rows as the folds read them: their range, and what a column of
 * them shows, by row.
 */
export interface Block {
  from: number;
  end: number;
  shown: (col: number) => (row: number) => string;
}

/**
 * Tallies folds a view's charts. A chart is attached to be folded, and is
 * pending until it hears its complete tally.
 */
export class Tallies {
  private readonly charts = new Map<string, Tallying>();
  /** The folds a save kept of charts not attached since, by chart id. */
  private kept: Readonly<Record<string, unknown>> = {};
  /** The rows the index a save kept holds, which no kept fold passes. */
  private readable = 0;
  /** Each column's decimal mark, by place, as `remark` was last told. */
  private marks: readonly Mark[] = [];

  /**
   * attach folds `chart`, keeping the fold of the chart with its id when it
   * reads the same columns the same way, or returns the header of a column
   * the view has not, which leaves the chart with no fold.
   */
  attach(chart: Chart, headers: readonly string[]): string | undefined {
    const { id, plot } = chart;
    const t = tallying(plot, headers, this.marks);
    if (typeof t === 'string') {
      this.charts.delete(id);
      return t;
    }
    const was = this.charts.get(id) ?? this.restored(id, t);
    if (was?.key === t.key && readsWith(was, this.marks)) {
      was.plot = plot;
      was.done = false;
      this.charts.set(id, was);
      return undefined;
    }
    this.charts.set(id, t);
    return undefined;
  }

  /**
   * restore keeps `saved`, the folds a save kept by chart id, for the charts
   * attach finds them for, over an index a save kept of `readable` rows.
   */
  restore(saved: Readonly<Record<string, unknown>>, readable: number): void {
    this.kept = saved;
    this.readable = readable;
  }

  /**
   * restored is `t` with the fold the save kept of the chart with `id`,
   * where it is of the same columns and holds no row past the index, which
   * attach keeps where it reads them with the same marks.
   */
  private restored(id: string, t: Tallying): Tallying | undefined {
    const saved = this.kept[id];
    if (!isRecord(saved) || saved['key'] !== t.key) return undefined;
    const { rows, ahead, fold } = saved;
    const run: unknown[] = Array.isArray(ahead) ? ahead : [rows, rows];
    const [from, end] = run;
    if (!isCount(rows) || !isCount(from) || !isCount(end)) return undefined;
    // A run folded ahead starts past the rows folded, and none passes the
    // index.
    const ran = from > rows;
    if (ran !== Array.isArray(ahead) || from > end || end > this.readable)
      return undefined;
    const on: Pick<Folding, 'rows' | 'ahead'> = {
      rows,
      ahead: ran ? [from, end] : undefined,
    };
    if (t.t === 'sample') {
      const back = SampleFold.restored(fold);
      return back && { ...t, ...on, fold: back };
    }
    const back = GroupsFold.restored(fold);
    return back && { ...t, ...on, fold: back };
  }

  /**
   * remark takes each column's decimal mark, by place, and starts the fold
   * of each chart that reads a column with another mark again from its
   * first row, with the mark now. It says whether any chart does.
   */
  remark(marks: readonly Mark[]): boolean {
    this.marks = marks;
    let refolded = false;
    for (const [id, t] of this.charts) {
      if (readsWith(t, marks)) continue;
      this.charts.set(id, fresh(t, marks));
      refolded = true;
    }
    return refolded;
  }

  /** detach stops folding the chart with `id`. */
  detach(id: string): void {
    this.charts.delete(id);
  }

  /**
   * saved is the fold of each chart that holds any row, by the chart's id,
   * as a save keeps it. A scatter an edit left stale is left out, to fold
   * again when it opens.
   */
  saved(): Record<string, SavedChart> {
    const saved: Record<string, SavedChart> = {};
    for (const [id, t] of this.charts) {
      if (t.t === 'sample' && t.fold.stale().length > 0) continue;
      if (t.rows === 0 && t.ahead === undefined) continue;
      const { key, rows, ahead } = t;
      saved[id] = { key, rows, ahead, fold: t.fold.saved() };
    }
    return saved;
  }

  /** How many charts are attached. */
  get size(): number {
    return this.charts.size;
  }

  /** from is the first row a pending chart lacks, or undefined when none is. */
  from(): number | undefined {
    let from: number | undefined;
    for (const t of this.charts.values()) {
      if (!t.done && (from === undefined || t.rows < from)) from = t.rows;
    }
    return from;
  }

  /**
   * wants says whether a pending chart's fold ends at `from`, so the block
   * there must be read for it.
   */
  wants(from: number): boolean {
    for (const t of this.charts.values()) {
      if (!t.done && t.rows === from) return true;
    }
    return false;
  }

  /**
   * lacks is where the rows that pending charts whose fold ends at `from`
   * lack from there on end: at the run each folded ahead, or past the last
   * row. `from` itself where no pending chart's fold ends at `from`.
   */
  lacks(from: number): number {
    let end = from;
    for (const t of this.charts.values()) {
      if (t.done || t.rows !== from) continue;
      end = Math.max(end, t.ahead?.[0] ?? Number.POSITIVE_INFINITY);
    }
    return end;
  }

  /**
   * fold adds `block`, the rows from `from` to `end`, to every pending chart
   * that can take it: as its next block, or ahead of the pass behind it.
   * `shown` returns what a column of the block shows, by row.
   */
  fold(
    block: number,
    from: number,
    end: number,
    shown: (col: number) => (row: number) => string,
  ): void {
    for (const t of this.charts.values()) {
      if (t.done || !takes(t, from)) continue;
      if (t.t === 'sample') {
        sample(t.fold, t, block, { from, end, shown });
      } else {
        const by = shown(t.by);
        const sum = t.sum === undefined ? undefined : shown(t.sum);
        for (let row = from; row < end; row++) {
          t.fold.add(by(row), sum?.(row));
        }
      }
      took(t, from, end);
    }
  }

  /**
   * cell moves each chart that has folded `row` of `block` and reads a
   * column the row shows otherwise now, by that one row: out as it showed
   * `before` the edit, and back in as it shows `after`. The ids of the
   * charts moved are returned, for mend.
   */
  cell(
    block: number,
    row: number,
    before: readonly string[],
    after: readonly string[],
  ): string[] {
    const shows = (col: number) => (before[col] ?? '') !== (after[col] ?? '');
    const moved: string[] = [];
    for (const [id, t] of this.charts) {
      if (!holds(t, row) || !colsOf(t).some(shows)) continue;
      move(t, block, row, before, after);
      moved.push(id);
    }
    return moved;
  }

  /**
   * mend reads again, through `read`, each block whose least or most the
   * row of a scatter among `moved` sat on, and folds it alone, so the
   * block's extent is exact again. Then each chart of `moved` is pending
   * again, so it hears its tally with the row moved. A read that fails
   * leaves them pending too, so the caller can say unread to them.
   */
  async mend(
    moved: readonly string[],
    read: (block: number) => Promise<Block>,
  ): Promise<void> {
    const charts = moved.flatMap((id) => this.charts.get(id) ?? []);
    try {
      for (const t of charts) {
        if (t.t !== 'sample') continue;
        for (const stale of t.fold.stale()) {
          const alone = new SampleFold(t.fold.marks);
          sample(alone, t, stale, await read(stale));
          t.fold.refold(stale, alone);
        }
      }
    } finally {
      for (const t of charts) t.done = false;
    }
  }

  /**
   * adopt takes over the folds of `was`'s charts for a view whose index
   * kept every block `was` read but `block`, its last, whose rows `last`
   * holds, and which the view reads again with the rows that follow. A fold
   * that holds the block gives its rows back, so every fold holds the kept
   * rows alone, and each chart is pending, to hear the rows that follow;
   * `was` is left with no chart. attach keeps a fold adopted while the
   * chart reads the same columns.
   */
  adopt(was: Tallies, block: number, last: Block): void {
    const kept = last.from;
    for (const [id, t] of was.charts) {
      // A fold takes blocks whole, so one that holds the block's first row
      // holds the block.
      if (holds(t, kept)) unfold(t, block, last);
      t.rows = Math.min(t.rows, kept);
      if (t.ahead !== undefined) {
        const [from, end] = t.ahead;
        t.ahead = from < kept ? [from, Math.min(end, kept)] : undefined;
      }
      t.done = false;
      this.charts.set(id, t);
    }
    // `was`, alive until it is closed, folds nothing more into these folds.
    was.charts.clear();
  }

  /**
   * reclaim takes the charts `now` adopted from this view back, each with
   * nothing folded, for an open of `now` that failed after adopt: a fold may
   * hold rows of the blocks `now` read again, which this view has not.
   */
  reclaim(now: Tallies): void {
    for (const [id, t] of now.charts) {
      this.charts.set(id, fresh(t, this.marks));
    }
    now.charts.clear();
  }

  /**
   * refold starts the fold of each chart that reads any of `cols` again
   * from its first row, for an edit that changed every row of them, and
   * says whether any chart does.
   */
  refold(cols: ReadonlySet<number>): boolean {
    let refolded = false;
    for (const [id, t] of this.charts) {
      if (!colsOf(t).some((col) => cols.has(col))) continue;
      this.charts.set(id, fresh(t, this.marks));
      refolded = true;
    }
    return refolded;
  }

  /**
   * read returns each pending chart's tally over `total` rows, complete once
   * the index is, `indexed`, and the chart has folded every row. A complete
   * one is the chart's last, until it is attached again or moved.
   */
  read(total: number, indexed: boolean): Array<[string, Tally]> {
    const read: Array<[string, Tally]> = [];
    for (const [id, t] of this.charts) {
      if (t.done) continue;
      const ahead = t.ahead === undefined ? 0 : t.ahead[1] - t.ahead[0];
      const complete = indexed && t.rows === total;
      const coverage = { rows: t.rows + ahead, total, complete };
      const { plot } = t;
      const tally: Tally =
        t.t === 'sample'
          ? { t: 'sample', plot, coverage, ...t.fold.snapshot() }
          : { t: 'groups', plot, coverage, ...t.fold.snapshot() };
      read.push([id, tally]);
      t.done = complete;
    }
    return read;
  }

  /**
   * unread returns, for each pending chart, or for each pending one of
   * `ids`, that its source could not be read.
   */
  unread(said: Said, ids?: readonly string[]): Array<[string, Tally]> {
    const unread: Array<[string, Tally]> = [];
    for (const id of ids ?? this.charts.keys()) {
      const t = this.charts.get(id);
      if (t === undefined || t.done) continue;
      unread.push([id, { t: 'unread', plot: t.plot, said }]);
      t.done = true;
    }
    return unread;
  }
}

/**
 * tallying makes the fold `plot` reads, over its columns where `headers`
 * put them and with the decimal marks `marks` gives them, or returns the
 * header of a column the view has not.
 */
function tallying(
  plot: Plot,
  headers: readonly string[],
  marks: readonly Mark[],
): Tallying | string {
  const folding = { ...unfolded(), plot };
  if (plot.t === 'scatter') {
    const x = placeOf(plot.x, headers);
    const y = placeOf(plot.y, headers);
    if (x === undefined) return plot.x.header;
    if (y === undefined) return plot.y.header;
    const key = `sample ${x} ${y}`;
    const fold = new SampleFold({ x: markOf(marks, x), y: markOf(marks, y) });
    return { ...folding, key, t: 'sample', fold, x, y };
  }
  const by = placeOf(plot.by, headers);
  if (by === undefined) return plot.by.header;
  if (plot.sum === undefined) {
    const key = `groups ${by}`;
    return { ...folding, key, t: 'groups', fold: new GroupsFold(), by };
  }
  const sum = placeOf(plot.sum, headers);
  if (sum === undefined) return plot.sum.header;
  const key = `groups ${by} ${sum}`;
  const fold = new GroupsFold('sum', markOf(marks, sum));
  return { ...folding, key, t: 'groups', fold, by, sum };
}

/** unfolded is how far a fold has got before any row: nothing, pending. */
function unfolded(): Omit<Folding, 'plot' | 'key'> {
  return { rows: 0, ahead: undefined, done: false };
}

/**
 * markOf is the decimal mark `marks` gives column `col`, or the point for
 * one it does not reach, as a fold made before any mark was inferred reads.
 */
function markOf(marks: readonly Mark[], col: number): Mark {
  return marks[col] ?? 'point';
}

/** readsWith says whether `t`'s fold reads its columns with `marks`. */
function readsWith(t: Tallying, marks: readonly Mark[]): boolean {
  if (t.t === 'groups') {
    return t.sum === undefined || t.fold.mark === markOf(marks, t.sum);
  }
  const { x, y } = t.fold.marks;
  return x === markOf(marks, t.x) && y === markOf(marks, t.y);
}

/** fresh is `t` with nothing folded, pending again, read with `marks`. */
function fresh(t: Tallying, marks: readonly Mark[]): Tallying {
  if (t.t === 'sample') {
    const read = { x: markOf(marks, t.x), y: markOf(marks, t.y) };
    return { ...t, ...unfolded(), fold: new SampleFold(read) };
  }
  const fold =
    t.sum === undefined
      ? new GroupsFold()
      : new GroupsFold('sum', markOf(marks, t.sum));
  return { ...t, ...unfolded(), fold };
}

/**
 * takes says whether the block from `from` is one `t` can fold: its next,
 * the next of the run it folded ahead, or the first of that run.
 */
function takes(t: Tallying, from: number): boolean {
  if (t.rows === from) return true;
  return t.ahead === undefined ? from > t.rows : t.ahead[1] === from;
}

/**
 * took records that `t` folded the rows from `from` to `end`, and joins the
 * run it folded ahead once its rows reach it.
 */
function took(t: Tallying, from: number, end: number): void {
  if (t.rows !== from) {
    t.ahead = t.ahead === undefined ? [from, end] : [t.ahead[0], end];
    return;
  }
  t.rows = end;
  if (t.ahead?.[0] === end) {
    t.rows = t.ahead[1];
    t.ahead = undefined;
  }
}

/**
 * holds says whether `t` has folded `row`: before its rows, or in the run
 * it folded ahead of them.
 */
function holds(t: Tallying, row: number): boolean {
  if (row < t.rows) return true;
  return t.ahead !== undefined && t.ahead[0] <= row && row < t.ahead[1];
}

/** colsOf lists the columns `t` reads, the one it groups by first. */
function colsOf(t: Tallying): number[] {
  if (t.t === 'sample') return [t.x, t.y];
  return t.sum === undefined ? [t.by] : [t.by, t.sum];
}

/** sample adds the rows of `block` to `fold`, as points of `x` against `y`. */
function sample(
  fold: SampleFold,
  { x, y }: { x: number; y: number },
  block: number,
  { from, end, shown }: Block,
): void {
  const xs = shown(x);
  const ys = shown(y);
  for (let row = from; row < end; row++) fold.add(block, row, xs(row), ys(row));
}

/**
 * unfold takes the rows of `block` out of `t`'s fold, as they showed, so
 * the block can be folded again whole. A sample's extent of the block is
 * empty until then.
 */
function unfold(t: Tallying, block: number, { from, end, shown }: Block): void {
  if (t.t === 'sample') {
    const xs = shown(t.x);
    const ys = shown(t.y);
    for (let row = from; row < end; row++) {
      t.fold.remove(block, row, xs(row), ys(row));
    }
    t.fold.refold(block, new SampleFold(t.fold.marks));
  } else {
    const by = shown(t.by);
    const sum = t.sum === undefined ? undefined : shown(t.sum);
    for (let row = from; row < end; row++) t.fold.remove(by(row), sum?.(row));
  }
}

/**
 * move takes `row` of `block` out of `t`'s fold as it showed `before`, and
 * puts it back as it shows `after`.
 */
function move(
  t: Tallying,
  block: number,
  row: number,
  before: readonly string[],
  after: readonly string[],
): void {
  const at = (shown: readonly string[], col: number | undefined) =>
    col === undefined ? '' : (shown[col] ?? '');
  if (t.t === 'sample') {
    t.fold.remove(block, row, at(before, t.x), at(before, t.y));
    t.fold.add(block, row, at(after, t.x), at(after, t.y));
  } else {
    t.fold.remove(at(before, t.by), at(before, t.sum));
    t.fold.add(at(after, t.by), at(after, t.sum));
  }
}

/**
 * placeOf finds a chart's column among the headers: where the chart left it
 * while the header there is its own, else where its header is now. The
 * renderer finds the column a tally read the same way.
 */
export function placeOf(
  column: ChartColumn,
  headers: readonly string[],
): number | undefined {
  if (headers[column.col] === column.header) return column.col;
  const at = headers.indexOf(column.header);
  return at < 0 ? undefined : at;
}
