/**
 * @fileoverview The folder of a scatter: a sample of one number column
 * against another, with the least and most of every block.
 */

import type { Plot } from '@document';
import type { Mark } from '@num';
import { SampleFold } from '@tally';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder, MakeFolder } from './folder.ts';

/** sampleFolder folds a plot's rows as points of `x` against `y`. */
export const sampleFolder: MakeFolder<Extract<Plot, { t: 'scatter' }>> = (
  plot,
  headers,
  marks,
) => {
  const x = placeOf(plot.x, headers);
  const y = placeOf(plot.y, headers);
  if (x === undefined) return plot.x.header;
  if (y === undefined) return plot.y.header;
  return sampled(x, y, marks);
};

/** sampled is the folder of points of `x` against `y`, holding `sample`. */
function sampled(
  x: number,
  y: number,
  marks: readonly Mark[],
  sample = new SampleFold({ x: markOf(marks, x), y: markOf(marks, y) }),
): Folder {
  /** into adds the rows of `block` to `fold`. */
  const into = (fold: SampleFold, block: number, rows: Block) => {
    const xs = rows.shown(x);
    const ys = rows.shown(y);
    for (let row = rows.from; row < rows.end; row++) {
      fold.add(block, row, xs(row), ys(row));
    }
  };
  return {
    key: `sample ${x} ${y}`,
    cols: [x, y],
    fold: (block, rows) => into(sample, block, rows),
    /** The block's extent is empty until it is folded again. */
    unfold(block, { from, end, shown }) {
      const xs = shown(x);
      const ys = shown(y);
      for (let row = from; row < end; row++) {
        sample.forget(row, xs(row), ys(row));
      }
      sample.refold(block, new SampleFold(sample.marks));
    },
    move(block, row, before, after) {
      sample.remove(block, row, before[x] ?? '', before[y] ?? '');
      sample.add(block, row, after[x] ?? '', after[y] ?? '');
    },
    readsWith: (now) =>
      sample.marks.x === markOf(now, x) && sample.marks.y === markOf(now, y),
    again: (now) => sampled(x, y, now),
    restored(saved) {
      const back = SampleFold.restored(saved);
      return back && sampled(x, y, marks, back);
    },
    /** A sample an edit left stale is left out, to fold again on open. */
    saved: () => (sample.stale().length > 0 ? undefined : sample.saved()),
    tally: (plot, coverage) => ({
      t: 'sample',
      plot,
      coverage,
      ...sample.snapshot(),
    }),
    /** Each block whose least or most an edit took back is folded alone. */
    async mend(read) {
      for (const stale of sample.stale()) {
        const alone = new SampleFold(sample.marks);
        into(alone, stale, await read(stale));
        sample.refold(stale, alone);
      }
    },
  };
}
