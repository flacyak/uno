/**
 * @fileoverview A view's charts, each folded over the rows read so far. A
 * chart reads the columns its plot names, found again by header where the
 * file moved them.
 */

import type { Chart, ChartColumn, Plot } from '@document';
import { GroupsFold, SampleFold } from '@tally';

/** Tallies folds a view's charts, each attached to be folded. */
export class Tallies {
  private readonly charts = new Map<
    string,
    { cols: number[]; fold: GroupsFold | SampleFold }
  >();

  /**
   * attach folds `chart` from its first row, or returns the header of a
   * column the view has not, which leaves the chart with no fold.
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
    const fold =
      plot.t === 'scatter'
        ? new SampleFold()
        : new GroupsFold(plot.sum === undefined ? 'rows' : 'sum');
    this.charts.set(id, { cols, fold });
    return undefined;
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
