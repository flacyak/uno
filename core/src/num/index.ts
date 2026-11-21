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
 * The full stop also separates thousands there, but only before a group of
 * GROUP_DIGITS digits, so it is taken off by `ungroup`.
 */
const COMMA_DECORATION = "$£€%' \u00a0\u202f";

/** GROUP_DIGITS is how many digits a thousands separator stands before. */
export const GROUP_DIGITS = 3;

// The characters a value may hold once decoration is removed. Anything else
// refuses the value before the parse, which keeps "inf", "NaN" and
// hexadecimal floats out.
const ALLOWED = '0123456789+-.eE';

/**
 * undress returns a copy of `v` with its decoration removed: every
 * DECORATION character for the point mark, and for the comma mark every
 * COMMA_DECORATION character and each full stop `ungroup` takes off.
 */
export function undress(v: string, mark: Mark): string {
  const decoration = mark === 'point' ? DECORATION : COMMA_DECORATION;
  let out = '';
  for (const r of v) {
    if (!decoration.includes(r)) out += r;
  }
  return mark === 'point' ? out : ungroup(out);
}

/**
 * ungroup removes each full stop that stands before exactly GROUP_DIGITS
 * digits, as in 1.234,56. Any other full stop is kept, so that 1.5 is not
 * read as 15 with the comma mark.
 */
function ungroup(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== '.' || digitsAt(v, i + 1) !== GROUP_DIGITS) out += v[i];
  }
  return out;
}

/** digitsAt counts the ASCII digits in `v` from `at` up to the next non-digit. */
function digitsAt(v: string, at: number): number {
  let end = at;
  while (end < v.length && v[end]! >= '0' && v[end]! <= '9') end++;
  return end - at;
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
 * markShown returns the decimal mark `v` shows beyond doubt, or undefined
 * when it shows none. A value with both marks shows its last as the decimal
 * mark: 1.234,56 and 1,234.56. A mark written twice separates thousands, so
 * the other one is the decimal mark: 1.234.567. A mark written once is the
 * decimal mark unless exactly GROUP_DIGITS digits follow it, as in 1,234,
 * which reads either way.
 */
export function markShown(v: string): Mark | undefined {
  const point = v.lastIndexOf('.');
  const comma = v.lastIndexOf(',');
  if (point >= 0 && comma >= 0) return point > comma ? 'point' : 'comma';
  if (point < 0 && comma < 0) return undefined;
  const at = Math.max(point, comma);
  const once: Mark = point >= 0 ? 'point' : 'comma';
  if (v.indexOf(v[at]!) !== at) return once === 'point' ? 'comma' : 'point';
  return digitsAt(v, at + 1) === GROUP_DIGITS ? undefined : once;
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
  const plain = plainAt(v, mark);
  if (plain !== NOT_PLAIN) return plainDecimal(v, plain);
  return decimal(signed(undress(trimSpace(v), mark)), mark);
}

const MINUS = 0x2d;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const MARK_CODE: Record<Mark, number> = { point: 0x2e, comma: 0x2c };
/** What plainAt returns for a value outside the plain shape. */
const NOT_PLAIN = -2;
/** What plainAt returns for a plain whole number, which has no mark. */
const WHOLE = -1;

/** isDigitCode reports whether `c` is the code of an ASCII digit. */
function isDigitCode(c: number): boolean {
  return c >= DIGIT_0 && c <= DIGIT_9;
}

/**
 * plainAt reads whether `v` is a plain decimal, `-?[0-9]+([mark][0-9]+)?`,
 * the shape exports and GPS loggers write. It returns where its mark stands,
 * WHOLE when it has none, and NOT_PLAIN for anything else, which the full
 * path reads. A plain decimal is what the full path reads unchanged, so
 * trimming, decoration and `signed` leave it as it was.
 */
function plainAt(v: string, mark: Mark): number {
  let i = v.length > 0 && v.charCodeAt(0) === MINUS ? 1 : 0;
  const first = i;
  while (i < v.length && isDigitCode(v.charCodeAt(i))) i++;
  if (i === first) return NOT_PLAIN;
  if (i === v.length) return WHOLE;
  if (v.charCodeAt(i) !== MARK_CODE[mark]) return NOT_PLAIN;
  const at = i++;
  while (i < v.length && isDigitCode(v.charCodeAt(i))) i++;
  if (i === at + 1 || i !== v.length) return NOT_PLAIN;
  return at;
}

/**
 * plainDecimal reads a plain decimal whose mark stands at `at`, as the full
 * path would: `Number` of it written with a full stop, which rounds once,
 * and undefined when it is too large for a float64.
 */
function plainDecimal(v: string, at: number): number | undefined {
  const n =
    at === WHOLE ? Number(v) : Number(v.slice(0, at) + '.' + v.slice(at + 1));
  return Number.isFinite(n) ? n : undefined;
}
