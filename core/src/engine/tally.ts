/**
 * @fileoverview A view's charts, each folded over the rows read so far.
 *
 * A pass over the view's blocks feeds every chart in order, so a chart's
 * fold holds every row before the first block it lacks. A chart reads the
 * columns its plot names, found again by header where the file moved them.
 */

import type { Chart, ChartColumn, Plot } from '@document';
import type { Said } from '@said';
import { GroupsFold, SampleFold } from '@tally';
import type { Tally } from './protocol.ts';

/** One chart's fold, and how far it has got. */
interface Tallying {
  /** Which fold the plot's columns make, so a like chart can keep it. */
  key: string;
  /** The plot's columns, where the view's headers put them. */
  cols: number[];
  fold: GroupsFold | SampleFold;
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
    const cols: number[] = [];
    for (const column of columnsOf(plot)) {
      const col = placeOf(column, headers);
      if (col === undefined) {
        this.charts.delete(id);
        return column.header;
      }
      cols.push(col);
    }
    const kind = plot.t === 'scatter' ? 'sample' : 'groups';
    const key = `${kind} ${cols.join(' ')}`;
    const was = this.charts.get(id);
    if (was?.key === key) {
      was.done = false;
      return undefined;
    }
    const fold =
      plot.t === 'scatter'
        ? new SampleFold()
        : new GroupsFold(plot.sum === undefined ? 'rows' : 'sum');
    const t = { key, cols, fold, rows: 0, ahead: undefined, done: false };
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
      const [first, second] = t.cols.map(shown);
      for (let row = from; row < end; row++) {
        if (t.fold instanceof SampleFold) {
          t.fold.add(block, row, first!(row), second!(row));
        } else {
          t.fold.add(first!(row), second === undefined ? '' : second(row));
        }
      }
      took(t, from, end);
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
        t.fold instanceof SampleFold
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

/** columnsOf lists the columns a plot reads, the one it groups by first. */
function columnsOf(plot: Plot): ChartColumn[] {
  if (plot.t === 'scatter') return [plot.x, plot.y];
  return plot.sum === undefined ? [plot.by] : [plot.by, plot.sum];
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
