import { trimSpace } from "../go/index.ts";
import { isNumber, undress } from "../num/index.ts";

/**
 * Kind is what a column looks like. It is inferred at load and lives in
 * memory only.
 */
export type Kind = "text" | "num" | "date";

/**
 * SAMPLE_ROWS is how many rows from the top of a column are read to infer
 * its kind.
 */
export const SAMPLE_ROWS = 200;

export interface Inferred {
  kind: Kind;
  flagged: boolean;
}

/**
 * inferKind reads the first SAMPLE_ROWS values of one column through `at`
 * and names its kind. Callers pass the display value, so a bound column is
 * judged by what it shows.
 *
 * Blank values are skipped. The kind is "date" when every value is a date,
 * "num" when every value is a number, and "text" otherwise. The column is
 * flagged when every value is a number or a number with formatting that
 * `undress` removes: a separator, a currency mark, a percent sign.
 */
export function inferKind(rows: number, at: (row: number) => string): Inferred {
  let seen = 0;
  let nums = 0;
  let formatted = 0;
  let dates = 0;

  for (let i = 0; i < rows && i < SAMPLE_ROWS; i++) {
    const v = trimSpace(at(i));
    if (v === "") continue; // a blank or a short row is skipped
    seen++;

    if (isDate(v)) dates++;
    else if (isNumber(v)) nums++;
    else if (isNumber(undress(v))) formatted++;
  }

  if (seen === 0) return { kind: "text", flagged: false };
  if (dates === seen) return { kind: "date", flagged: false };
  if (nums === seen) return { kind: "num", flagged: false };
  if (nums + formatted === seen) return { kind: "text", flagged: true };
  return { kind: "text", flagged: false };
}

// The layouts a date can be written in: year first with one separator, year
// last the same way, a month by name, and RFC 3339. These are matched by
// hand because `new Date` accepts far more.
const YEAR_FIRST = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/;
// Nov. 6, 1970 and November 6 1970; 6 Nov 1970 and 06-Nov-1970.
const NAME_FIRST = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/;
const DAY_FIRST = /^(\d{1,2})([ -])([A-Za-z]+)\.?\2(\d{4})$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// A month is its full name or its three-letter form, plus "sept".
const MONTHS = new Map<string, number>();
[
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
].forEach((name, i) => {
  MONTHS.set(name, i + 1);
  MONTHS.set(name.slice(0, 3), i + 1);
});
MONTHS.set("sept", 9);

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

/** Each date layout, with a check that its fields make a real date. */
const DATE_SHAPES: ReadonlyArray<[RegExp, (m: RegExpExecArray) => boolean]> = [
  [YEAR_FIRST, (m) => isRealDate(Number(m[1]), Number(m[3]), Number(m[4]))],
  // 20-11-2024 is day first and 11/20/2024 is month first. Either reading
  // counts.
  [
    YEAR_LAST,
    (m) =>
      isRealDate(Number(m[4]), Number(m[3]), Number(m[1])) ||
      isRealDate(Number(m[4]), Number(m[1]), Number(m[3])),
  ],
  [NAME_FIRST, (m) => isRealDate(Number(m[3]), month(m[1]!), Number(m[2]))],
  [DAY_FIRST, (m) => isRealDate(Number(m[4]), month(m[3]!), Number(m[1]))],
  [
    RFC3339,
    (m) =>
      isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) &&
      // Seconds stop at 59, so a leap second reads as text.
      Number(m[4]) <= 23 &&
      Number(m[5]) <= 59 &&
      Number(m[6]) <= 59,
  ],
];
