/**
 * @fileoverview The folder of a stacked bar chart or a slope chart: rows per
 * value of one column and per value of another in the same row, or the sum
 * of a third, of every value of the other or of a slope's two.
 */

import type { SlopePlot, StackPlot } from '@document';
import type { Mark } from '@num';
import { SplitFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder } from './folder.ts';

/**
 * splitFolder folds rows by a plot's `by` and its series, a stack's `split`
 * or a slope's `between`, summing a stack's `sum` or a slope's `of` if it
 * names one, or returns the header of a column the view has not. A slope
 * folds the rows of its two states alone, which it draws from first, and
 * every state's behind them.
 */
export function splitFolder(
  plot: StackPlot | SlopePlot,
  headers: readonly string[],
  marks: readonly Mark[],
): Folder | string {
  const [series, summed] =
    plot.t === 'stack' ? [plot.split, plot.sum] : [plot.between, plot.of];
  const by = placeOf(plot.by, headers);
  if (by === undefined) return plot.by.header;
  const split = placeOf(series, headers);
  if (split === undefined) return series.header;
  const sum = summed === undefined ? undefined : placeOf(summed, headers);
  if (summed !== undefined && sum === undefined) return summed.header;
  const only = plot.t === 'slope' ? ([plot.from, plot.to] as const) : undefined;
  return splitted({ keys: [by, split], sum, only }, marks);
}

/** The two columns a split fold counts each row by: its value's, and its series'. */
type Keys = readonly [by: number, split: number];

/**
 * What a split folder counts: the columns it counts each row by, the column
 * it sums, if any, and the only two series whose rows it counts, if any.
 */
interface Counted {
  keys: Keys;
  sum: number | undefined;
  only?: readonly [string, string];
}

/** splitted is the folder of the rows `counted` says, holding `fold`. */
function splitted(
  counted: Counted,
  marks: readonly Mark[],
  fold = new SplitFold(
    counted.sum === undefined ? undefined : markOf(marks, counted.sum),
  ),
): Folder {
  const {
    keys: [by, split],
    sum,
    only,
  } = counted;
  const kept = (series: string) => only === undefined || only.includes(series);
  /** each counts every row of a block it keeps, by its value, its series and its summed cell. */
  const each = (
    { from, end, shown }: Block,
    count: (value: string, series: string, cell: string) => void,
  ) => {
    const [values, series] = [shown(by), shown(split)];
    const cells = sum === undefined ? undefined : shown(sum);
    for (let row = from; row < end; row++) {
      const named = series(row);
      if (kept(named)) count(values(row), named, cells?.(row) ?? '');
    }
  };
  const at = (shown: readonly string[], col: number | undefined) =>
    col === undefined ? '' : (shown[col] ?? '');
  const cols = sum === undefined ? [by, split] : [by, split, sum];
  // Two states' rows alone are another fold than every series', named apart.
  const states = only === undefined ? '' : ` ${JSON.stringify(only)}`;
  return {
    key: `${only === undefined ? 'split' : 'pair'} ${cols.join(' ')}${states}`,
    cols,
    fold: (_, rows) => each(rows, (v, s, cell) => fold.add(v, s, cell)),
    unfold: (_, rows) => each(rows, (v, s, cell) => fold.remove(v, s, cell)),
    move(_, _row, before, after) {
      const [was, now] = [at(before, split), at(after, split)];
      if (kept(was)) fold.remove(at(before, by), was, at(before, sum));
      if (kept(now)) fold.add(at(after, by), now, at(after, sum));
    },
    readsWith: (now) => sum === undefined || fold.mark === markOf(now, sum),
    again: (now) => splitted(counted, now),
    restored(saved) {
      const back = SplitFold.restored(saved);
      return back && splitted(counted, marks, back);
    },
    saved: () => fold.saved(),
    behind:
      only === undefined
        ? undefined
        : splitted({ ...counted, only: undefined }, marks),
    tally: (plot, coverage) => {
      const moved = plot.t === 'stack' ? plot.order : [];
      if (plot.t !== 'slope')
        return { t: 'stack', plot, coverage, ...fold.snapshot(moved) };
      const mean = plot.measure === 'mean';
      return {
        t: 'slope',
        plot,
        coverage,
        ...fold.slope([plot.from, plot.to], mean),
      };
    },
    mend: () => Promise.resolve(),
  };
}
