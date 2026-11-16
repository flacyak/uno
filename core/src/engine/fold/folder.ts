/**
 * @fileoverview What the engine's tallies need of one chart's fold, whatever
 * its kind, so a kind is one entry in a table the compiler checks.
 */

import type { ChartColumn, Plot } from '@document';
import type { Mark } from '@num';
import type { Coverage, Tally } from '../protocol.ts';

/**
 * A block's rows as the folds read them: their range, and what a column of
 * them shows, by row.
 */
export interface Block {
  from: number;
  end: number;
  shown: (col: number) => (row: number) => string;
}

/**
 * Folder is one chart's fold, over the columns its plot names where the
 * view put them: what the tallies need of it, whatever the chart's kind.
 */
export interface Folder {
  /** Which fold the plot's columns make, so a like chart can keep it. */
  readonly key: string;
  /** The columns it reads, by place; an edit to any moves it. */
  readonly cols: readonly number[];
  /** fold adds the rows of `block`. */
  fold(block: number, rows: Block): void;
  /** unfold takes the rows of `block` back as they showed. */
  unfold(block: number, rows: Block): void;
  /** move takes `row` back as it showed `before`, and adds it as `after`. */
  move(
    block: number,
    row: number,
    before: readonly string[],
    after: readonly string[],
  ): void;
  /** readsWith says whether it reads each column with its mark in `marks`. */
  readsWith(marks: readonly Mark[]): boolean;
  /** again is a folder of the same columns, read with `marks`, empty. */
  again(marks: readonly Mark[]): Folder;
  /** restored is one of the same columns holding `saved`, if it holds one. */
  restored(saved: unknown): Folder | undefined;
  /** saved is the fold a save keeps, or none where an edit left it inexact. */
  saved(): object | undefined;
  /** tally is what it holds, as the chart of `plot` hears it. */
  tally(plot: Plot, coverage: Coverage): Tally;
  /** mend folds again, alone, each block an edit left it inexact over. */
  mend(read: (block: number) => Promise<Block>): Promise<void>;
}

/**
 * MakeFolder makes the folder of a `P`, over its columns where `headers` put
 * them and with the decimal marks `marks` gives them, or returns the header
 * of a column the view has not.
 */
export type MakeFolder<P extends Plot> = (
  plot: P,
  headers: readonly string[],
  marks: readonly Mark[],
) => Folder | string;

/**
 * markOf is the decimal mark `marks` gives column `col`, or the point for
 * one it does not reach, as a fold made before any mark was inferred reads.
 */
export function markOf(marks: readonly Mark[], col: number): Mark {
  return marks[col] ?? 'point';
}

/**
 * placeOf finds a chart's column among the headers: where the chart left it
 * while the header there is its own, else where its header is now. The
 * renderer finds the column a tally read the same way.
 */
export function placeOf(
  column: ChartColumn,
  headers: readonly string[],
): number | undefined {
  if (headers[column.col] === column.header) return column.col;
  const at = headers.indexOf(column.header);
  return at < 0 ? undefined : at;
}
