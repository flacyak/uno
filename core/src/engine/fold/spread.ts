/** @fileoverview The folder of a histogram or a box plot: the numbers of one column, read with its mark. */

import type { Plot } from '@document';
import type { Mark } from '@num';
import { SpreadFold } from '@tally';
import { counted } from './counted.ts';
import { markOf, placeOf } from './folder.ts';
import type { Folder, MakeFolder } from './folder.ts';

type Spreading = Extract<Plot, { t: 'histogram' | 'box' }>;

/** spreadFolder folds the numbers of a plot's `of`. */
export const spreadFolder: MakeFolder<Spreading> = (plot, headers, marks) => {
  const of = placeOf(plot.of, headers);
  return of === undefined ? plot.of.header : spread(of, marks);
};

/** spread is the folder of the numbers of `of`, read with its mark in `marks`. */
function spread(
  of: number,
  marks: readonly Mark[],
  fold = new SpreadFold(markOf(marks, of)),
): Folder {
  const boxed = () => fold.boxed();
  const folder = counted(of, undefined, fold, {
    key: `spread ${of}`,
    again: (now) => spread(of, now),
    restored(saved) {
      const back = SpreadFold.restored(saved);
      return back?.mark === fold.mark ? spread(of, marks, back) : undefined;
    },
    // A histogram and a box plot of the same column share the fold.
    tally: (plot, coverage) =>
      plot.t === 'box'
        ? {
            t: 'box',
            plot,
            coverage,
            values: [],
            rest: boxed(),
            skipped: boxed().skipped,
          }
        : {
            t: 'spread',
            plot,
            coverage,
            ...fold.snapshot(plot.t === 'histogram' ? plot.span : 'most'),
          },
  });
  return { ...folder, readsWith: (now) => fold.mark === markOf(now, of) };
}
