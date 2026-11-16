/**
 * @fileoverview The folder of a bars or pie chart: rows per value of one
 * column, or the sum of another per value.
 */

import type { Plot } from '@document';
import type { Mark } from '@num';
import { GroupsFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder, MakeFolder } from './folder.ts';

/** groupsFolder folds rows by a plot's `by`, summing `sum` if it names one. */
export const groupsFolder: MakeFolder<Extract<Plot, { t: 'bars' | 'pie' }>> = (
  plot,
  headers,
  marks,
) => {
  const by = placeOf(plot.by, headers);
  if (by === undefined) return plot.by.header;
  if (plot.sum === undefined) return grouped(by, undefined, marks);
  const sum = placeOf(plot.sum, headers);
  return sum === undefined ? plot.sum.header : grouped(by, sum, marks);
};

/** grouped is the folder of rows by `by`, summing `sum`, holding `groups`. */
function grouped(
  by: number,
  sum: number | undefined,
  marks: readonly Mark[],
  groups = sum === undefined
    ? new GroupsFold()
    : new GroupsFold('sum', markOf(marks, sum)),
): Folder {
  const cols = sum === undefined ? [by] : [by, sum];
  /** each counts every row of a block, by its value and its summed cell. */
  const each = (
    { from, end, shown }: Block,
    count: (value: string, cell?: string) => void,
  ) => {
    const values = shown(by);
    const cells = sum === undefined ? undefined : shown(sum);
    for (let row = from; row < end; row++) count(values(row), cells?.(row));
  };
  const at = (shown: readonly string[], col: number | undefined) =>
    col === undefined ? '' : (shown[col] ?? '');
  return {
    key: `groups ${cols.join(' ')}`,
    cols,
    fold: (_, rows) => each(rows, (value, cell) => groups.add(value, cell)),
    unfold: (_, rows) =>
      each(rows, (value, cell) => groups.remove(value, cell)),
    move(_, _row, before, after) {
      groups.remove(at(before, by), at(before, sum));
      groups.add(at(after, by), at(after, sum));
    },
    readsWith: (now) => sum === undefined || groups.mark === markOf(now, sum),
    again: (now) => grouped(by, sum, now),
    restored(saved) {
      const back = GroupsFold.restored(saved);
      return back && grouped(by, sum, marks, back);
    },
    saved: () => groups.saved(),
    tally: (plot, coverage) => ({
      t: 'groups',
      plot,
      coverage,
      ...groups.snapshot(),
    }),
    mend: () => Promise.resolve(),
  };
}
