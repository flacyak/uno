/**
 * @fileoverview The folder of a bars or pie chart: rows per value of one
 * column, or the sum of another per value.
 */

import type { Plot } from '@document';
import type { Mark } from '@num';
import { GroupsFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Folder, MakeFolder } from './folder.ts';
import { counted } from './counted.ts';

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
  return counted(by, sum, groups, {
    key: `groups ${sum === undefined ? by : `${by} ${sum}`}`,
    again: (now) => grouped(by, sum, now),
    restored(saved) {
      const back = GroupsFold.restored(saved);
      return back && grouped(by, sum, marks, back);
    },
    tally: (plot, coverage) => ({
      t: 'groups',
      plot,
      coverage,
      ...groups.snapshot(),
    }),
  });
}
