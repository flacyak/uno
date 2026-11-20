/** @fileoverview The folder of a box plot by a column: a spread of one column's numbers per value of another. */

import type { Plot } from '@document';
import type { Mark } from '@num';
import { SpreadsFold } from '@tally';
import { counted } from './counted.ts';
import { markOf, placeOf } from './folder.ts';
import type { Folder, MakeFolder } from './folder.ts';
import { spreadFolder } from './spread.ts';

/** boxFolder folds a box plot's `of`, by the values of its `by` where it names one. */
export const boxFolder: MakeFolder<Extract<Plot, { t: 'box' }>> = (
  plot,
  headers,
  marks,
) => {
  if (plot.by === undefined) return spreadFolder(plot, headers, marks);
  const [by, of] = [placeOf(plot.by, headers), placeOf(plot.of, headers)];
  if (by === undefined) return plot.by.header;
  return of === undefined ? plot.of.header : spreads(by, of, marks);
};

/** spreads is the folder of the numbers of `of` per value of `by`, read with its mark in `marks`. */
function spreads(
  by: number,
  of: number,
  marks: readonly Mark[],
  fold = new SpreadsFold(markOf(marks, of)),
): Folder {
  return counted(by, of, fold, {
    key: `spreads ${by} ${of}`,
    again: (now) => spreads(by, of, now),
    restored(saved) {
      const back = SpreadsFold.restored(saved);
      return back?.mark === fold.mark
        ? spreads(by, of, marks, back)
        : undefined;
    },
    tally: (plot, coverage) => ({
      t: 'box',
      plot,
      coverage,
      ...fold.snapshot(),
      skipped: fold.skipped(),
    }),
  });
}
