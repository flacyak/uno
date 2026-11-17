/**
 * @fileoverview The folder of an over-time chart: rows, or the sum of another
 * column, per period of a date column, read as the chart says its dates read.
 */

import type { TimePlot } from '@document';
import type { Mark } from '@num';
import { TimeFold } from '@tally';
import { counted } from './counted.ts';
import { markOf, placeOf } from './folder.ts';
import type { Folder, MakeFolder } from './folder.ts';

/** timeFolder folds rows by the period of a plot's `at`, summing `sum` if it names one. */
export const timeFolder: MakeFolder<TimePlot> = (plot, headers, marks) => {
  const at = placeOf(plot.at, headers);
  if (at === undefined) return plot.at.header;
  const reading = 'order' in plot ? plot.order : plot.unit;
  if (plot.sum === undefined) return timed(at, undefined, reading, marks);
  const sum = placeOf(plot.sum, headers);
  return sum === undefined ? plot.sum.header : timed(at, sum, reading, marks);
};

/** timed is the folder of rows by the period of `at` read as `reading`, summing `sum`. */
function timed(
  at: number,
  sum: number | undefined,
  reading: TimeFold['reading'],
  marks: readonly Mark[],
  fold = new TimeFold(
    reading,
    sum === undefined ? undefined : markOf(marks, sum),
  ),
): Folder {
  return counted(at, sum, fold, {
    key: `time ${at} ${reading}${sum === undefined ? '' : ` ${sum}`}`,
    again: (now) => timed(at, sum, reading, now),
    restored(saved) {
      const back = TimeFold.restored(saved);
      return back?.reading === reading
        ? timed(at, sum, reading, marks, back)
        : undefined;
    },
    batch: (per, offset) => fold.batch(per, offset),
    // A chart that changed only its size keeps the fold, read at its size now.
    tally: (plot, coverage) => ({
      t: 'time',
      plot,
      coverage,
      ...fold.snapshot(plot.t === 'time' ? plot.per : 'auto'),
    }),
  });
}
