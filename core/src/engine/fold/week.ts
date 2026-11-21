/**
 * @fileoverview The folder of a week heatmap: rows, or the sum of another
 * column, per hour of the week of a date column, read as the chart says its
 * dates read.
 */

import type { WeekPlot } from '@document';
import type { Mark } from '@num';
import { WeekFold } from '@tally';
import { counted } from './counted.ts';
import { markOf, placeOf } from './folder.ts';
import type { Folder, MakeFolder } from './folder.ts';

/** weekFolder folds rows by the hour of the week of a plot's `at`, summing `sum` if it names one. */
export const weekFolder: MakeFolder<WeekPlot> = (plot, headers, marks) => {
  const at = placeOf(plot.at, headers);
  if (at === undefined) return plot.at.header;
  const reading = 'order' in plot ? plot.order : plot.unit;
  if (plot.sum === undefined) return weeked(at, undefined, reading, marks);
  const sum = placeOf(plot.sum, headers);
  return sum === undefined ? plot.sum.header : weeked(at, sum, reading, marks);
};

/** weeked is the folder of rows by the hour of the week of `at` read as `reading`, summing `sum`. */
function weeked(
  at: number,
  sum: number | undefined,
  reading: WeekFold['reading'],
  marks: readonly Mark[],
  fold = new WeekFold(
    reading,
    sum === undefined ? undefined : markOf(marks, sum),
  ),
): Folder {
  return counted(at, sum, fold, {
    key: `week ${at} ${reading}${sum === undefined ? '' : ` ${sum}`}`,
    again: (now) => weeked(at, sum, reading, now),
    restored(saved) {
      const back = WeekFold.restored(saved);
      return back?.reading === reading
        ? weeked(at, sum, reading, marks, back)
        : undefined;
    },
    tally: (plot, coverage) => ({
      t: 'week',
      plot,
      coverage,
      ...fold.snapshot(),
    }),
  });
}
