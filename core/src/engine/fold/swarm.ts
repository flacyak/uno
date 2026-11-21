/** @fileoverview The folder of a beeswarm: a sample of each value's rows by rank, and every row's least and most. */

import type { SwarmPlot } from '@document';
import type { Mark } from '@num';
import { SwarmFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder } from './folder.ts';

/** swarmFolder folds a beeswarm's `of`, by the values of its `by` where it names one. */
export function swarmFolder(
  plot: SwarmPlot,
  headers: readonly string[],
  marks: readonly Mark[],
): Folder | string {
  const of = placeOf(plot.of, headers);
  if (of === undefined) return plot.of.header;
  if (plot.by === undefined) return swarmed(undefined, of, marks);
  const by = placeOf(plot.by, headers);
  return by === undefined ? plot.by.header : swarmed(by, of, marks);
}

/** A row's value and number cell, as a swarm fold reads them. */
type Cells = (row: number) => [string, string];

/** swarmed is the folder of the numbers of `of` per value of `by`, or one value where it is undefined. */
function swarmed(
  by: number | undefined,
  of: number,
  marks: readonly Mark[],
  fold = new SwarmFold(markOf(marks, of)),
): Folder {
  const cellsOf = ({ shown }: Block): Cells => {
    const [values, numbers] = [
      by === undefined ? () => '' : shown(by),
      shown(of),
    ];
    return (row) => [values(row), numbers(row)];
  };
  const at = (shown: readonly string[]): [string, string] => [
    by === undefined ? '' : (shown[by] ?? ''),
    shown[of] ?? '',
  ];
  /** into adds the rows of `block` to `swarm`. */
  const into = (swarm: SwarmFold, block: number, rows: Block) => {
    const cells = cellsOf(rows);
    for (let row = rows.from; row < rows.end; row++)
      swarm.add(block, row, ...cells(row));
  };
  return {
    key: by === undefined ? `swarm ${of}` : `swarm ${of} ${by}`,
    cols: by === undefined ? [of] : [of, by],
    fold: (block, rows) => into(fold, block, rows),
    /** The block's extent is empty until it is folded again. */
    unfold(block, rows) {
      const cells = cellsOf(rows);
      for (let row = rows.from; row < rows.end; row++)
        fold.forget(row, ...cells(row));
      fold.refold(block, new SwarmFold(fold.mark));
    },
    move(block, row, before, after) {
      fold.remove(block, row, ...at(before));
      fold.add(block, row, ...at(after));
    },
    readsWith: (now) => fold.mark === markOf(now, of),
    again: (now) => swarmed(by, of, now),
    restored(saved) {
      const back = SwarmFold.restored(saved);
      return back?.mark === fold.mark
        ? swarmed(by, of, marks, back)
        : undefined;
    },
    /** A fold an edit left stale is left out, to fold again on open. */
    saved: () => (fold.stale().length > 0 ? undefined : fold.saved()),
    tally: (plot, coverage) => ({
      t: 'swarm',
      plot,
      coverage,
      ...fold.snapshot(),
    }),
    /** Each block whose least or most an edit took back is folded alone. */
    async mend(read) {
      for (const stale of fold.stale()) {
        const alone = new SwarmFold(fold.mark);
        into(alone, stale, await read(stale));
        fold.refold(stale, alone);
      }
    },
  };
}
