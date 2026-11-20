/**
 * @fileoverview The folder of a bars or pie chart or a dot plot: rows per
 * value of one column, or the sum or mean of another per value.
 */

import type { DotMeasure, DotsPlot, Plot } from '@document';
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

/**
 * dotsFolder folds rows by a dot plot's `by`, summing `of` where it names
 * one, as bars do, or meaning it, a fold of its own.
 */
export const dotsFolder: MakeFolder<DotsPlot> = (plot, headers, marks) => {
  const by = placeOf(plot.by, headers);
  if (by === undefined) return plot.by.header;
  if (plot.of === undefined) return grouped(by, undefined, marks);
  const of = placeOf(plot.of, headers);
  return of === undefined
    ? plot.of.header
    : grouped(by, of, marks, plot.measure);
};

/**
 * grouped is the folder of rows by `by`, summing `sum`, or meaning it where
 * `measure` says, holding `groups`.
 */
function grouped(
  by: number,
  sum: number | undefined,
  marks: readonly Mark[],
  measure: DotMeasure = 'sum',
  groups = sum === undefined
    ? new GroupsFold()
    : new GroupsFold(measure, markOf(marks, sum)),
): Folder {
  const kind = measure === 'mean' ? 'mean' : 'groups';
  return counted(by, sum, groups, {
    key: `${kind} ${sum === undefined ? by : `${by} ${sum}`}`,
    again: (now) => grouped(by, sum, now, measure),
    restored(saved) {
      const back = GroupsFold.restored(saved);
      return back && grouped(by, sum, marks, measure, back);
    },
    tally: (plot, coverage) => {
      const moved = plot.t === 'bars' || plot.t === 'dots' ? plot.order : [];
      return measure === 'mean'
        ? { t: 'mean', plot, coverage, ...groups.means(moved) }
        : { t: 'groups', plot, coverage, ...groups.snapshot(moved) };
    },
  });
}
