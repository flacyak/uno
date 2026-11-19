/**
 * @fileoverview The folder of a stacked bar chart: rows per value of one
 * column and per value of another in the same row, or the sum of a third.
 */

import type { StackPlot } from '@document';
import type { Mark } from '@num';
import { SplitFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder } from './folder.ts';

/**
 * splitFolder folds rows by a plot's `by` and `split`, summing `sum` if it
 * names one, or returns the header of a column the view has not.
 */
export function splitFolder(
  plot: StackPlot,
  headers: readonly string[],
  marks: readonly Mark[],
): Folder | string {
  const by = placeOf(plot.by, headers);
  if (by === undefined) return plot.by.header;
  const split = placeOf(plot.split, headers);
  if (split === undefined) return plot.split.header;
  if (plot.sum === undefined) return splitted([by, split], undefined, marks);
  const sum = placeOf(plot.sum, headers);
  return sum === undefined
    ? plot.sum.header
    : splitted([by, split], sum, marks);
}

/** The two columns a split fold counts each row by: its value's, and its series'. */
type Keys = readonly [by: number, split: number];

/** splitted is the folder of rows by `keys`, summing `sum`, holding `fold`. */
function splitted(
  [by, split]: Keys,
  sum: number | undefined,
  marks: readonly Mark[],
  fold = new SplitFold(sum === undefined ? undefined : markOf(marks, sum)),
): Folder {
  /** each counts every row of a block, by its value, its series and its summed cell. */
  const each = (
    { from, end, shown }: Block,
    count: (value: string, series: string, cell: string) => void,
  ) => {
    const [values, series] = [shown(by), shown(split)];
    const cells = sum === undefined ? undefined : shown(sum);
    for (let row = from; row < end; row++) {
      count(values(row), series(row), cells?.(row) ?? '');
    }
  };
  const at = (shown: readonly string[], col: number | undefined) =>
    col === undefined ? '' : (shown[col] ?? '');
  const cols = sum === undefined ? [by, split] : [by, split, sum];
  return {
    key: `split ${cols.join(' ')}`,
    cols,
    fold: (_, rows) => each(rows, (v, s, cell) => fold.add(v, s, cell)),
    unfold: (_, rows) => each(rows, (v, s, cell) => fold.remove(v, s, cell)),
    move(_, _row, before, after) {
      fold.remove(at(before, by), at(before, split), at(before, sum));
      fold.add(at(after, by), at(after, split), at(after, sum));
    },
    readsWith: (now) => sum === undefined || fold.mark === markOf(now, sum),
    again: (now) => splitted([by, split], sum, now),
    restored(saved) {
      const back = SplitFold.restored(saved);
      return back && splitted([by, split], sum, marks, back);
    },
    saved: () => fold.saved(),
    tally: (plot, coverage) => ({
      t: 'stack',
      plot,
      coverage,
      ...fold.snapshot(plot.t === 'stack' ? plot.order : []),
    }),
    mend: () => Promise.resolve(),
  };
}
