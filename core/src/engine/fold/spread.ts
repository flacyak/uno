/** @fileoverview The folder of a histogram: the numbers of one column, read with its mark. */

import type { Plot } from '@document';
import type { Mark } from '@num';
import { SpreadFold } from '@tally';
import { counted } from './counted.ts';
import { markOf, placeOf } from './folder.ts';
import type { Folder, MakeFolder } from './folder.ts';

type Histogram = Extract<Plot, { t: 'histogram' }>;

/** spreadFolder folds the numbers of a plot's `of`. */
export const spreadFolder: MakeFolder<Histogram> = (plot, headers, marks) => {
  const of = placeOf(plot.of, headers);
  return of === undefined ? plot.of.header : spread(of, marks);
};

/** spread is the folder of the numbers of `of`, read with its mark in `marks`. */
function spread(
  of: number,
  marks: readonly Mark[],
  fold = new SpreadFold(markOf(marks, of)),
): Folder {
  const folder = counted(of, undefined, fold, {
    key: `spread ${of}`,
    again: (now) => spread(of, now),
    restored(saved) {
      const back = SpreadFold.restored(saved);
      return back?.mark === fold.mark ? spread(of, marks, back) : undefined;
    },
    tally: (plot, coverage) => ({
      t: 'spread',
      plot,
      coverage,
      ...fold.snapshot(plot.t === 'histogram' ? plot.span : 'most'),
    }),
  });
  return { ...folder, readsWith: (now) => fold.mark === markOf(now, of) };
}
