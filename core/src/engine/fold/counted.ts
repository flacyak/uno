/**
 * @fileoverview A folder whose fold counts each row by its cell in one
 * column, summing its cell in another where it names one, as the folds of
 * bars, a pie and an over-time chart do.
 */

import type { Mark } from '@num';
import { markOf } from './folder.ts';
import type { Block, Folder } from './folder.ts';

/** A fold of rows, each by its cell in one column and the one it sums. */
export interface Counting {
  /** The mark summed cells are read with; undefined when counting rows. */
  readonly mark: Mark | undefined;
  add(cell: string, summed?: string): void;
  remove(cell: string, summed?: string): void;
  saved(): object;
}

/** What a counted folder is that depends on its fold's kind. */
export type Kind = Pick<
  Folder,
  'key' | 'again' | 'restored' | 'tally' | 'batch'
>;

/**
 * counted is the folder of `fold`, over rows by `by`, summing `sum` where it
 * names one, with the rest of it from `kind`.
 */
export function counted(
  by: number,
  sum: number | undefined,
  fold: Counting,
  kind: Kind,
): Folder {
  /** each counts every row of a block, by its cell and its summed cell. */
  const each = (
    { from, end, shown }: Block,
    count: (cell: string, summed?: string) => void,
  ) => {
    const cells = shown(by);
    const summed = sum === undefined ? undefined : shown(sum);
    for (let row = from; row < end; row++) count(cells(row), summed?.(row));
  };
  const at = (shown: readonly string[], col: number | undefined) =>
    col === undefined ? '' : (shown[col] ?? '');
  return {
    ...kind,
    cols: sum === undefined ? [by] : [by, sum],
    fold: (_, rows) => each(rows, (cell, summed) => fold.add(cell, summed)),
    unfold: (_, rows) =>
      each(rows, (cell, summed) => fold.remove(cell, summed)),
    move(_, _row, before, after) {
      fold.remove(at(before, by), at(before, sum));
      fold.add(at(after, by), at(after, sum));
    },
    readsWith: (marks) => sum === undefined || fold.mark === markOf(marks, sum),
    saved: () => fold.saved(),
    mend: () => Promise.resolve(),
  };
}
