// Package num reads the number a spreadsheet cell holds.
//
// It is shared by `sheet` and `formula`. It works on one string at a time:
// a string goes in and a number or undefined comes out.

import { parseFloat as parseDecimal, trimSpace } from "../go/index.ts";

/**
 * DECORATION is the characters stripped from a value before it is read as a
 * number. The full stop is kept, as the decimal mark.
 */
export const DECORATION = ",$£€%' ";

// The characters a value may hold once decoration is removed. Anything else
// refuses the value before the parse, which keeps "inf", "NaN" and
// hexadecimal floats out.
const ALLOWED = "0123456789+-.eE";

/** undress returns a copy of `v` with every DECORATION character removed. */
export function undress(v: string): string {
  let out = "";
  for (const r of v) {
    if (!DECORATION.includes(r)) out += r;
  }
  return out;
}

/**
 * signed rewrites two accounting forms of a negative into a leading minus:
 * (1234.00) and 1234.00- both become -1234.00. Anything else is returned
 * unchanged.
 */
export function signed(v: string): string {
  if (v.length > 2 && v.startsWith("(") && v.endsWith(")")) return "-" + v.slice(1, -1);
  if (v.length > 1 && v.endsWith("-")) return "-" + v.slice(0, -1);
  return v;
}

/** isNumber reports whether `v`, after `signed`, is a plain decimal number. */
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
 * parse reads a cell as a number: trims White_Space from both ends, removes
 * decoration, applies `signed`, then parses. Returns undefined when what is
 * left fails to read as a decimal number.
 */
export function parse(v: string): number | undefined {
  return decimal(signed(undress(trimSpace(v))));
}
