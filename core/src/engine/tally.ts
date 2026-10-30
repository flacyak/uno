/**
 * @fileoverview A view's charts, each folded over the rows read so far.
 *
 * A pass over the view's blocks feeds every chart in order, so a chart's
 * fold holds every row before the first block it lacks, and an edit moves
 * a fold by the one row it changed. A chart reads the columns its plot
 * names, found again by header where the file moved them.
 */

import type { Chart, ChartColumn, Plot } from '@document';
import type { Said } from '@said';
import { GroupsFold, SampleFold } from '@tally';
import type { Tally } from './protocol.ts';

/** How far one chart's fold has got. */
interface Folding {
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

  /**
   * attach folds `chart`, keeping the fold of the chart with its id when it
   * reads the same columns the same way, or returns the header of a column
   * the view has not, which leaves the chart with no fold.
   */
  attach(chart: Chart, headers: readonly string[]): string | undefined {
    const { id, plot } = chart;
    const t = tallying(plot, headers);
    if (typeof t === 'string') {
      this.charts.delete(id);
      return t;
    }
    const was = this.charts.get(id);
    if (was?.key === t.key) {
      was.done = false;
      return undefined;
    }
    this.charts.set(id, t);
    return undefined;
  }

  /** detach stops folding the chart with `id`. */
  detach(id: string): void {
    this.charts.delete(id);
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
          const alone = new SampleFold();
          sample(alone, t, stale, await read(stale));
          t.fold.refold(stale, alone);
        }
      }
    } finally {
      for (const t of charts) t.done = false;
    }
  }

  /**
   * read returns each pending chart's tally over `total` rows. A complete one
   * is the chart's last, until it is attached again.
   */
  read(total: number, complete: boolean): Array<[string, Tally]> {
    const read: Array<[string, Tally]> = [];
    for (const [id, t] of this.charts) {
      if (t.done) continue;
      const ahead = t.ahead === undefined ? 0 : t.ahead[1] - t.ahead[0];
      const coverage = { rows: t.rows + ahead, total, complete };
      const tally: Tally =
        t.t === 'sample'
          ? { t: 'sample', coverage, ...t.fold.snapshot() }
          : { t: 'groups', coverage, ...t.fold.snapshot() };
      read.push([id, tally]);
      t.done = complete;
    }
    return read;
  }

  /** unread returns, for each pending chart, that its source could not be read. */
  unread(said: Said): Array<[string, Tally]> {
    const unread: Array<[string, Tally]> = [];
    for (const [id, t] of this.charts) {
      if (t.done) continue;
      unread.push([id, { t: 'unread', said }]);
      t.done = true;
    }
    return unread;
  }
}

/**
 * tallying makes the fold `plot` reads, over its columns where `headers`
 * put them, or returns the header of a column the view has not.
 */
function tallying(plot: Plot, headers: readonly string[]): Tallying | string {
  const folding = unfolded();
  if (plot.t === 'scatter') {
    const x = placeOf(plot.x, headers);
    const y = placeOf(plot.y, headers);
    if (x === undefined) return plot.x.header;
    if (y === undefined) return plot.y.header;
    const key = `sample ${x} ${y}`;
    return { ...folding, key, t: 'sample', fold: new SampleFold(), x, y };
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
  const fold = new GroupsFold('sum');
  return { ...folding, key, t: 'groups', fold, by, sum };
}

/** unfolded is how far a fold has got before any row: nothing, pending. */
function unfolded(): Omit<Folding, 'key'> {
  return { rows: 0, ahead: undefined, done: false };
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
 * while the header there is its own, else where its header is now.
 */
function placeOf(
  column: ChartColumn,
  headers: readonly string[],
): number | undefined {
  if (headers[column.col] === column.header) return column.col;
  const at = headers.indexOf(column.header);
  return at < 0 ? undefined : at;
}
