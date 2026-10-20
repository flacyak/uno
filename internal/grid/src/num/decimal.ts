// Decimal text in and out: the forms a number is read from and written to.

/**
 * formatFloat is the shortest decimal that reads back as the same float64,
 * in plain notation. `Number.prototype.toString` switches to exponential
 * above 1e21 and below 1e-6.
 */
export function formatFloat(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  // A negative zero keeps its sign; JavaScript's toString drops it.
  if (Object.is(v, -0)) return '-0';

  const s = v.toString();
  const e = s.indexOf('e');
  if (e < 0) return s;

  const exp = Number(s.slice(e + 1));
  let mantissa = s.slice(0, e);
  let sign = '';
  if (mantissa.startsWith('-')) {
    sign = '-';
    mantissa = mantissa.slice(1);
  }

  const dot = mantissa.indexOf('.');
  let digits = mantissa;
  let point = mantissa.length;
  if (dot >= 0) {
    digits = mantissa.slice(0, dot) + mantissa.slice(dot + 1);
    point = dot;
  }
  point += exp;

  if (point <= 0) return sign + '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length)
    return sign + digits + '0'.repeat(point - digits.length);
  return sign + digits.slice(0, point) + '.' + digits.slice(point);
}

/**
 * roundSignificant keeps n significant digits. Turns 0.21999999999999997
 * into 0.22.
 */
export function roundSignificant(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v;
  return Number(v.toPrecision(digits));
}

// The decimal forms a number is read from. Hexadecimal and infinity
// spellings are refused.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * parseFloat reads a decimal. Returns undefined for anything else, including
 * "", "0x10" and " 12 ", which `Number()` would accept.
 */
export function parseFloat(v: string): number | undefined {
  if (!DECIMAL.test(v)) return undefined;
  const n = Number(v);
  // A decimal too large for a float64 is undefined: 1e400 overflows it.
  return Number.isFinite(n) ? n : undefined;
}

/**
 * atoi reads a whole decimal integer. Returns undefined for anything else.
 */
export function atoi(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}
