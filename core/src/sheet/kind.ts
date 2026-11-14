/**
 * @fileoverview What a column looks like, inferred from a sample of its rows at
 * open: text, number or date, whether it is flagged, and its decimal mark.
 */

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
  if (dates === seen) return { kind: 'date', flagged: false, mark };
  if (nums === seen) return { kind: 'num', flagged: false, mark };
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

// The layouts a date can be written in: year first with one separator, year
// last the same way, a year and month, and a month by name. A year-first or
// year-last date may go on to a time of day as RFC 3339 writes it, with the
// seconds and the offset optional. These are matched by hand because
// `new Date` accepts far more.
const TIME = String.raw`(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?`;
const YEAR_FIRST = new RegExp(
  String.raw`^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})${TIME}$`,
);
const YEAR_LAST = new RegExp(
  String.raw`^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})${TIME}$`,
);
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
// Nov. 6, 1970 and November 6 1970; 6 Nov 1970 and 06-Nov-1970.
const NAME_FIRST = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/;
const DAY_FIRST = /^(\d{1,2})([ -])([A-Za-z]+)\.?\2(\d{4})$/;

/** The last hour of a day. */
const LAST_HOUR = 23;
/** The last minute of an hour, and the last second of a minute. */
const LAST_MINUTE = 59;

// A month is its full name or its three-letter form, plus "sept".
const MONTHS = new Map<string, number>();
[
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
].forEach((name, i) => {
  MONTHS.set(name, i + 1);
  MONTHS.set(name.slice(0, 3), i + 1);
});
MONTHS.set('sept', 9);

function month(name: string): number {
  return MONTHS.get(name.toLowerCase()) ?? 0;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the next month is the last day of this one.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isDate(v: string): boolean {
  for (const [shape, real] of DATE_SHAPES) {
    const m = shape.exec(v);
    if (m !== null) return real(m);
  }
  return false;
}

/**
 * Whether the time a YEAR_FIRST or YEAR_LAST match wrote, in groups 5 to 7, is
 * a real one, or there is none. Seconds stop at 59, so a leap second reads as
 * text.
 */
function isRealTime(m: RegExpExecArray): boolean {
  const [hours, minutes, seconds] = [m[5], m[6], m[7]];
  if (hours === undefined) return true;
  return (
    Number(hours) <= LAST_HOUR &&
    Number(minutes) <= LAST_MINUTE &&
    (seconds === undefined || Number(seconds) <= LAST_MINUTE)
  );
}

/** Each date layout, with a check that its fields make a real date. */
const DATE_SHAPES: ReadonlyArray<[RegExp, (m: RegExpExecArray) => boolean]> = [
  [
    YEAR_FIRST,
    (m) =>
      isRealDate(Number(m[1]), Number(m[3]), Number(m[4])) && isRealTime(m),
  ],
  // 20-11-2024 is day first and 11/20/2024 is month first. Either reading
  // counts.
  [
    YEAR_LAST,
    (m) =>
      (isRealDate(Number(m[4]), Number(m[3]), Number(m[1])) ||
        isRealDate(Number(m[4]), Number(m[1]), Number(m[3]))) &&
      isRealTime(m),
  ],
  // A year and month reads as its first day.
  [YEAR_MONTH, (m) => isRealDate(Number(m[1]), Number(m[2]), 1)],
  [NAME_FIRST, (m) => isRealDate(Number(m[3]), month(m[1]!), Number(m[2]))],
  [DAY_FIRST, (m) => isRealDate(Number(m[4]), month(m[3]!), Number(m[1]))],
];
