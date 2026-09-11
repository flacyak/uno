import { trimSpace } from "../go/index.ts";
import { isNumber, undress } from "../num/index.ts";

/**
 * Kind is what a column looks like. It is inferred at load and never stored in
 * the file, so changing the inference rules can never invalidate a saved sheet.
 *
 * A string union rather than a numbered enum: the Go type's whole observable
 * surface is its `String()` method, and the numbers were never written anywhere.
 */
export type Kind = "text" | "num" | "date";

/**
 * sampleRows bounds the work done at open. Measuring all 4,812 rows of six
 * columns to name their kinds costs 28,872 parses before the first frame; the
 * top of the file is enough to catch the shape of a column.
 */
export const SAMPLE_ROWS = 200;

export interface Inferred {
  kind: Kind;
  flagged: boolean;
}

/**
 * inferKind reads down one column of the sample and names it.
 *
 * It takes a reader rather than the rows, because a bound column has no stored
 * values to read: what a formula computes lives in the display cache, and the
 * badge over it has to describe the numbers a person can see rather than the
 * empty strings underneath them. Callers pass `display`, which answers for both
 * kinds of column without this having to know which it is looking at.
 *
 * The flagged case is the one worth being precise about. A column is flagged
 * when every value would be a number but for a formatting convention the parser
 * does not accept: a separator, a currency mark, a percent sign. That is a
 * stricter test than "mostly numeric", and deliberately so: a column with the
 * odd "N/A" in it is genuinely mixed, whereas a column where 1,204 sits beside
 * 987 is numeric data wearing a costume, and it is the second the recogniser
 * offers to fix.
 */
export function inferKind(rows: number, at: (row: number) => string): Inferred {
  let seen = 0;
  let nums = 0;
  let formatted = 0;
  let dates = 0;

  for (let i = 0; i < rows && i < SAMPLE_ROWS; i++) {
    const v = trimSpace(at(i));
    if (v === "") continue; // a blank, or a ragged row: not evidence either way
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

// The two layouts Go parses: a plain date, and RFC 3339. Spelled out rather
// than handed to `new Date`, which accepts far more than Go does -- "2026",
// "July 1 2026" and "2026-07-01T25:00:00Z" would all become dates, and a text
// column would come back wearing a date badge.
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the next month is the last day of this one.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isDate(v: string): boolean {
  const plain = PLAIN_DATE.exec(v);
  if (plain !== null) {
    return isRealDate(Number(plain[1]), Number(plain[2]), Number(plain[3]));
  }

  const full = RFC3339.exec(v);
  if (full === null) return false;
  if (!isRealDate(Number(full[1]), Number(full[2]), Number(full[3]))) return false;

  const hh = Number(full[4]);
  const mm = Number(full[5]);
  const ss = Number(full[6]);
  return hh <= 23 && mm <= 59 && ss <= 60; // Go accepts a leap second
}
