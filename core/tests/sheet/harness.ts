/**
 * @fileoverview Shared helpers for the tests of supplied columns: an edit
 * built from its parts, every operation an edit can make, and the files
 * three rows came from.
 */

import { NO_ROW, Op } from '@sheet';
import type { Edit } from '@sheet';

/** Every operation, with a value and a row it can name. */
export const OPS: Array<[Edit['op'], string, number]> = [
  [Op.Set, 'c.csv', 0],
  [Op.Note, 'x^2', 0],
  [Op.Apply, 'trim', NO_ROW],
  [Op.Bind, 'units * 2', NO_ROW],
  [Op.Unbind, '', NO_ROW],
];

/** An edit of `col` to `now`, at `row` or at no row. */
export function edit(
  op: Edit['op'],
  col: number,
  now: string,
  row: number = NO_ROW,
): Edit {
  return { seq: 0, op, row, col, now };
}

/** Each row's supplied values, one array shared by the rows of a file. */
const IN_A = ['a.csv'];
const IN_B = ['b.csv'];

/** The supplied values of three rows: two from a.csv, then one from b.csv. */
export const FILES = [IN_A, IN_A, IN_B];
