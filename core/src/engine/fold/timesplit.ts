/**
 * @fileoverview The folder of a heatmap over periods: rows, or the sum of
 * another column, per value of one column and per period of a date column.
 */

import type { HeatPlot } from '@document';
import type { Mark } from '@num';
import { TimeSplitFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder } from './folder.ts';

/** timeSplitFolder folds rows by a plot's `by` and the period of its `at`, summing `sum` if it names one. */
export function timeSplitFolder(
  plot: HeatPlot,
  headers: readonly string[],
  marks: readonly Mark[],
): Folder | string {
  const by = placeOf(plot.by, headers);
  const at = placeOf(plot.at, headers);
  const sum = plot.sum === undefined ? undefined : placeOf(plot.sum, headers);
  if (by === undefined) return plot.by.header;
  if (at === undefined) return plot.at.header;
  if (plot.sum !== undefined && sum === undefined) return plot.sum.header;
  const reading = 'order' in plot ? plot.order : plot.unit;
  return timeSplit([by, at, sum], reading, marks);
}

/** timeSplit is the folder of rows by `by` and the period of `at` read as `reading`, summing `sum`. */
function timeSplit(
  cols: readonly [by: number, at: number, sum: number | undefined],
  reading: TimeSplitFold['reading'],
  marks: readonly Mark[],
  fold = new TimeSplitFold(
    reading,
    cols[2] === undefined ? undefined : markOf(marks, cols[2]),
  ),
): Folder {
  const [by, at, sum] = cols;
  const cell = (shown: readonly string[], col: number | undefined) =>
    col === undefined ? '' : (shown[col] ?? '');
  /** each counts every row of a block by its value, its date and its summed cell. */
  const each = ({ from, end, shown }: Block, sign: 1 | -1) => {
    const [values, dates] = [shown(by), shown(at)];
    const cells = sum === undefined ? undefined : shown(sum);
    for (let row = from; row < end; row++) {
      const counted = [values(row), dates(row), cells?.(row) ?? ''] as const;
      if (sign > 0) fold.add(...counted);
      else fold.remove(...counted);
    }
  };
  return {
    key: `timesplit ${by} ${at} ${reading}${sum === undefined ? '' : ` ${sum}`}`,
    cols: sum === undefined ? [by, at] : [by, at, sum],
    fold: (_, rows) => each(rows, 1),
    unfold: (_, rows) => each(rows, -1),
    move(_, _row, before, after) {
      fold.remove(cell(before, by), cell(before, at), cell(before, sum));
      fold.add(cell(after, by), cell(after, at), cell(after, sum));
    },
    readsWith: (now) => sum === undefined || fold.mark === markOf(now, sum),
    again: (now) => timeSplit(cols, reading, now),
    restored(saved) {
      const back = TimeSplitFold.restored(saved);
      return back?.reading === reading
        ? timeSplit(cols, reading, marks, back)
        : undefined;
    },
    saved: () => fold.saved(),
    // A chart that changed only its size keeps the fold, read at its size now.
    tally: (plot, coverage) => {
      const per = 'per' in plot ? plot.per : 'auto';
      return { t: 'heat', plot, coverage, ...fold.snapshot(per) };
    },
    mend: () => Promise.resolve(),
  };
}
