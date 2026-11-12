/**
 * @fileoverview Package num reads the number a spreadsheet cell holds.
 *
 * It is shared by `sheet` and `formula`. It works on one string at a time:
 * a string and the column's decimal mark go in, and a number or undefined
 * comes out.
 */

import { parseFloat as parseDecimal, trimSpace } from '@go';

/**
 * Mark is the decimal mark a column's numbers are written with: the full
 * stop, as in 1,234.56, or the comma, as in 1.234,56.
 */
export type Mark = 'point' | 'comma';

/**
 * DECORATION is the characters stripped from a value before it is read as a
 * number with the point mark. The full stop is kept, as the decimal mark.
 */
export const DECORATION = ",$£€%' ";

/**
 * COMMA_DECORATION is the characters stripped from a value before it is read
 * as a number with the comma mark: the symbols DECORATION strips, and the
 * spaces that separate thousands, the no-break and narrow no-break ones too.
 */
const COMMA_DECORATION = "$£€%' \u00a0\u202f";

// The characters a value may hold once decoration is removed. Anything else
// refuses the value before the parse, which keeps "inf", "NaN" and
// hexadecimal floats out.
const ALLOWED = '0123456789+-.eE';

/**
 * undress returns a copy of `v` with every character of its mark's
 * decoration removed: DECORATION for the point mark, COMMA_DECORATION for
 * the comma mark.
 */
export function undress(v: string, mark: Mark): string {
  const decoration = mark === 'point' ? DECORATION : COMMA_DECORATION;
  let out = '';
  for (const r of v) {
    if (!decoration.includes(r)) out += r;
  }
  return out;
}

/**
 * signed rewrites two accounting forms of a negative into a leading minus:
 * (1234.00) and 1234.00- both become -1234.00. Anything else is returned
 * unchanged.
 */
export function signed(v: string): string {
  if (v.length > 2 && v.startsWith('(') && v.endsWith(')'))
    return '-' + v.slice(1, -1);
  if (v.length > 1 && v.endsWith('-')) return '-' + v.slice(0, -1);
  return v;
}

/**
 * isNumber reports whether `v`, after `signed`, is a plain decimal number
 * written with `mark`.
 */
export function isNumber(v: string, mark: Mark): boolean {
  return decimal(signed(v), mark) !== undefined;
}

/**
 * decimal reads `v` as a number written with `mark`. With the comma mark, a
 * full stop refuses the value and the comma reads as the decimal mark.
 */
function decimal(v: string, mark: Mark): number | undefined {
  if (mark === 'comma') {
    if (v.includes('.')) return undefined;
    v = v.replaceAll(',', '.');
  }
  for (const r of v) {
    if (!ALLOWED.includes(r)) return undefined;
  }
  return parseDecimal(v);
}

/**
 * parse reads a cell as a number written with `mark`: trims White_Space from
 * both ends, removes decoration, applies `signed`, then parses. Returns
 * undefined when what is left fails to read as a decimal number.
 */
export function parse(v: string, mark: Mark): number | undefined {
  return decimal(signed(undress(trimSpace(v), mark)), mark);
}
