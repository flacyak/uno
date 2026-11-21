/**
 * @fileoverview The folder of a sample of number columns, with the least and
 * most of every block: a scatter's, of one column against another, and
 * parallel coordinates', of three to eight.
 */

import type { ParallelPlot, Plot } from '@document';
import type { Mark } from '@num';
import { SampleFold, pointsOf, restoredPoints, savedPoints } from '@tally';
import type { Coverage, Tally } from '../protocol.ts';
import { markOf, placeOf } from './folder.ts';
import type { Block, Folder, MakeFolder } from './folder.ts';

/** How a sample saves and what a chart hears of it: a scatter's points, or parallel coordinates' axes. */
interface Heard {
  saved(fold: SampleFold): object;
  restored(saved: unknown): SampleFold | undefined;
  tally(fold: SampleFold, plot: Plot, coverage: Coverage): Tally;
}

/** A scatter saves and hears its sample as points, as it did of x and y alone. */
const POINTS: Heard = {
  saved: (fold) => savedPoints(fold.saved()),
  restored: restoredPoints,
  tally: (fold, plot, coverage) => ({
    t: 'sample',
    plot,
    coverage,
    ...pointsOf(fold.snapshot()),
  }),
};

/** Parallel coordinates save and hear a number per axis. */
const AXES: Heard = {
  saved: (fold) => fold.saved(),
  restored: (saved) => SampleFold.restored(saved),
  tally: (fold, plot, coverage) => ({
    t: 'parallel',
    plot,
    coverage,
    ...fold.snapshot(),
  }),
};

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
  return sampled([x, y], marks, POINTS);
};

/** parallelFolder folds a plot's rows as a number on each of its axes. */
export const parallelFolder: MakeFolder<ParallelPlot> = (
  plot,
  headers,
  marks,
) => {
  const cols: number[] = [];
  for (const axis of plot.axes) {
    const at = placeOf(axis, headers);
    if (at === undefined) return axis.header;
    cols.push(at);
  }
  return sampled(cols, marks, AXES);
};

/** sampled is the folder of the numbers of `cols`, holding `sample`, saved and heard as `heard` says. */
function sampled(
  cols: readonly number[],
  marks: readonly Mark[],
  heard: Heard,
  sample = new SampleFold(cols.map((col) => markOf(marks, col))),
): Folder {
  /** each gives the cells of `cols` of each row of `rows`. */
  const each = ({ from, end, shown }: Block): Array<[number, string[]]> => {
    const columns = cols.map((col) => shown(col));
    return Array.from({ length: end - from }, (_, i) => [
      from + i,
      columns.map((cell) => cell(from + i)),
    ]);
  };
  /** into adds the rows of `block` to `fold`. */
  const into = (fold: SampleFold, block: number, rows: Block) => {
    for (const [row, cells] of each(rows)) fold.add(block, row, ...cells);
  };
  const cellsOf = (shown: readonly string[]) =>
    cols.map((col) => shown[col] ?? '');
  return {
    key: `sample ${cols.join(' ')}`,
    cols,
    fold: (block, rows) => into(sample, block, rows),
    /** The block's extent is empty until it is folded again. */
    unfold(block, rows) {
      for (const [row, cells] of each(rows)) sample.forget(row, ...cells);
      sample.refold(block, new SampleFold(sample.marks));
    },
    move(block, row, before, after) {
      sample.remove(block, row, ...cellsOf(before));
      sample.add(block, row, ...cellsOf(after));
    },
    readsWith: (now) =>
      cols.every((col, k) => sample.marks[k] === markOf(now, col)),
    again: (now) => sampled(cols, now, heard),
    restored(saved) {
      const back = heard.restored(saved);
      return back && sampled(cols, marks, heard, back);
    },
    /** A sample an edit left stale is left out, to fold again on open. */
    saved: () => (sample.stale().length > 0 ? undefined : heard.saved(sample)),
    tally: (plot, coverage) => heard.tally(sample, plot, coverage),
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
