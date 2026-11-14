/**
 * @fileoverview What a column looks like, inferred from a sample of its rows at
 * open: text, number or date, whether it is flagged, and its decimal mark.
 */

import type { ShownOrder, UnixUnit } from '@date';
import { inferOrder, inferUnit, readDate } from '@date';
import { trimSpace } from '@go';
import type { Mark } from '@num';
import { isNumber, markShown, parse, undress } from '@num';

/**
 * Kind is what a column looks like. It is inferred at load and lives in
 * memory only.
 */
export type Kind = 'text' | 'num' | 'date';

/**
 * SAMPLE_ROWS is how many rows from the top of a column are read to infer
 * its kind.
 */
export const SAMPLE_ROWS = 200;

export interface Inferred {
  kind: Kind;
  flagged: boolean;
  /** The decimal mark every reader of the column's numbers reads with. */
  mark: Mark;
  /**
   * How a date column's dates written year last read, as `inferOrder` names
   * it. Absent when the column is not dates or writes none year last.
   */
  order?: ShownOrder;
  /**
   * The unit of Unix time a number column's whole numbers are, as `inferUnit`
   * names it. The column stays a number for sums, sorting and find.
   */
  unit?: UnixUnit;
}

/**
 * inferKind reads the first SAMPLE_ROWS values of one column through `at`
 * and names its kind. Callers pass the display value, so a bound column is
 * judged by what it shows.
 *
 * Blank values are skipped. The kind is "date" when every value is a date,
 * "num" when every value is a number, and "text" otherwise. The column is
 * flagged when every value is a number or a number with formatting that
 * `undress` removes: a separator, a currency mark, a percent sign. Numbers
 * are read with the mark `inferMark` names.
 */
export function inferKind(rows: number, at: (row: number) => string): Inferred {
  const values: string[] = [];
  for (let i = 0; i < rows && i < SAMPLE_ROWS; i++) {
    const v = trimSpace(at(i));
    if (v !== '') values.push(v); // a blank or a short row is skipped
  }
  const mark = inferMark(values);

  let nums = 0;
  let formatted = 0;
  let dates = 0;
  for (const v of values) {
    if (isDate(v)) dates++;
    else if (isNumber(v, mark)) nums++;
    else if (isNumber(undress(v, mark), mark)) formatted++;
  }

  const seen = values.length;
  if (seen === 0) return { kind: 'text', flagged: false, mark };
  if (dates === seen) {
    const order = inferOrder(values);
    const date: Inferred = { kind: 'date', flagged: false, mark };
    return order === undefined ? date : { ...date, order };
  }
  if (nums === seen) {
    const unit = inferUnit(values);
    const num: Inferred = { kind: 'num', flagged: false, mark };
    return unit === undefined ? num : { ...num, unit };
  }
  if (nums + formatted === seen) return { kind: 'text', flagged: true, mark };
  return { kind: 'text', flagged: false, mark };
}

/**
 * inferMark names the decimal mark of a column's sampled `values`: the comma
 * when some value shows it, as `markShown` reads it, and none shows the
 * point. Otherwise it is the point, so a column whose values disagree reads
 * as it always has, and its odd cells count as not numbers. A value counts
 * only where it reads as a number with the mark it shows.
 */
export function inferMark(values: readonly string[]): Mark {
  let commas = 0;
  for (const v of values) {
    const shown = markShown(v);
    if (shown === undefined || parse(v, shown) === undefined) continue;
    if (shown === 'point') return 'point';
    commas++;
  }
  return commas > 0 ? 'comma' : 'point';
}

/**
 * isDate is whether `v` reads as a date in either order, so a column of
 * 03/04/2024 and 13/04/2024 is a date column whichever it turns out to be.
 */
export function isDate(v: string): boolean {
  return readDate(v, 'day') !== undefined || readDate(v, 'month') !== undefined;
}
