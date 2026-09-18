// Package num reads the number a spreadsheet cell holds, which is not always
// the number a parser reads.
//
// It is its own module because two callers need one answer and neither can own
// it. `sheet` asks whether a column is numeric data wearing a costume, and
// `formula` asks what a cell is worth before multiplying it; sheet imports
// formula, so formula can never import sheet back, and the coercion cannot live
// in either. A second copy of it would be the copy that quietly stops matching
// the first.
//
// Nothing here knows what a sheet is. A value arrives as the string it was
// stored as and leaves as a number or as nothing.

import { parseFloat as parseDecimal } from "../go/index.ts";

/**
 * DECORATION is what a number wears when it was formatted for a reader rather
 * than for a parser.
 *
 * The set is fixed and short, and leaves out the full stop: the badge it feeds
 * claims a column is numeric data in a costume, and a wider set would let it
 * claim that about text.
 */
export const DECORATION = ",$£€%' ";

// The characters `strconv.ParseFloat` may see, once the decoration is off.
// Anything outside this refuses the value before the parse runs, which is what
// keeps "inf", "NaN" and hexadecimal floats out of a numeric column.
const ALLOWED = "0123456789+-.eE";

/**
 * undress strips that formatting, so a caller can ask whether what is left is a
 * number. It changes no stored value: the raw bytes are authoritative and this
 * reads a copy of them.
 */
export function undress(v: string): string {
  let out = "";
  for (const r of v) {
    if (!DECORATION.includes(r)) out += r;
  }
  return out;
}

/**
 * signed rewrites the two ways accounting exports write a negative into the
 * one a parser reads: Oracle's (1234.00) and SAP's trailing 1234.00-. Both
 * become -1234.00. Anything else comes back as it was.
 *
 * These are not decoration. Taking them off would flip the sign, so they
 * are read as a sign here rather than stripped with the costume.
 */
export function signed(v: string): string {
  if (v.length > 2 && v.startsWith("(") && v.endsWith(")")) return "-" + v.slice(1, -1);
  if (v.length > 1 && v.endsWith("-")) return "-" + v.slice(0, -1);
  return v;
}

/**
 * isNumber is deliberately stricter than a plain parse. Both Go's
 * `strconv.ParseFloat` and JavaScript's `Number` accept spellings a spreadsheet
 * column never means, so the value must first look like a decimal number.
 */
export function isNumber(v: string): boolean {
  return decimal(signed(v)) !== undefined;
}

function decimal(v: string): number | undefined {
  for (const r of v) {
    if (!ALLOWED.includes(r)) return undefined;
  }
  return parseDecimal(v);
}

/**
 * parse reads a cell as arithmetic reads it: undressed first, so a column an
 * evaluator was pointed at computes on the value a person sees rather than
 * refusing 1,204 for wearing a comma.
 *
 * It reports `undefined` rather than throwing because the caller that has
 * something to say about the failure is the one that knows which column and
 * which row the value came from, and this module knows neither.
 */
export function parse(v: string): number | undefined {
  return decimal(signed(undress(v)));
}
