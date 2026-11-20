/**
 * @fileoverview A number's bucket at some significant figures, read as its
 * cell wrote them, for a spread that holds too many numbers to keep each.
 */

/**
 * Added to a number's decimal exponent in its key: more than the 324 places
 * a double reaches below 1, so the key of every number past zero is too.
 */
const EXPONENT_OFFSET = 400;
/** The greatest power of ten a double holds exactly. */
const EXACT_POWER_AT_MOST = 22;
/** The greatest power of ten a double reaches, and the least. */
const POWER_AT_MOST = 308;
const POWER_AT_LEAST = -324;
/**
 * How near a whole number, relatively, a scaled cell is read as it: nearer
 * than a cell of 15 written figures comes, and farther than the few roundings
 * of a cell and its scaling go.
 */
const SNAP = 2 ** -50;
const DIGITS = 10;

/**
 * scaled is `x` times 10^`k`, rounded once where 10^`k` is exact, and
 * otherwise twice, or four times past the powers a double reaches.
 */
function scaled(x: number, k: number): number {
  if (Math.abs(k) <= EXACT_POWER_AT_MOST) {
    return k >= 0 ? x * DIGITS ** k : x / DIGITS ** -k;
  }
  if (Math.abs(k) <= POWER_AT_MOST) return x * Number(`1e${k}`);
  const part = Math.sign(k) * POWER_AT_MOST;
  return scaled(scaled(x, part), k - part);
}

/** snapped is `s`, or the whole number within SNAP of it, so 0.29 scaled by 100 reads 29 as written. */
function snapped(s: number): number {
  const whole = Math.round(s);
  return Math.abs(s - whole) <= Math.abs(s) * SNAP ? whole : s;
}

/**
 * keyOf is the key of the bucket `x` falls in at `f` figures: its exponent
 * and leading digits. A bucket past zero is [d, d + 1) in units of its last
 * figure, and one below zero [-c, -c + 1), so each holds its low end. Keys
 * sort as their buckets do, and 0 is its own.
 */
export function keyOf(x: number, f: number): number {
  if (x === 0) return 0;
  const top = DIGITS ** f;
  const lead = (e: number) => snapped(scaled(Math.abs(x), f - 1 - e));
  let e = Math.floor(Math.log10(Math.abs(x)));
  if (x > 0) {
    while (lead(e) >= top) e++;
    while (lead(e) < top / DIGITS) e--;
    return (e + EXPONENT_OFFSET) * top + Math.floor(lead(e));
  }
  while (lead(e) > top) e++;
  while (lead(e) <= top / DIGITS) e--;
  return -((e + EXPONENT_OFFSET) * top + Math.ceil(lead(e)));
}

/** splitKey is a key's exponent, offset, and leading digits at `f` figures. */
function splitKey(key: number, f: number): [number, number] {
  const top = DIGITS ** f;
  // Digits past zero are never 0, and below it may be `top`: one less finds the exponent of both.
  const offset = Math.floor((Math.abs(key) - 1) / top);
  return [offset, Math.abs(key) - offset * top];
}

/** isKey says whether `key` names a bucket at `f` figures, as keyOf gives one. */
export function isKey(key: number, f: number): boolean {
  if (key === 0) return true;
  if (!Number.isSafeInteger(key)) return false;
  const [offset, digits] = splitKey(key, f);
  const [least, top] = [DIGITS ** (f - 1), DIGITS ** f];
  const e = offset - EXPONENT_OFFSET;
  if (e < POWER_AT_LEAST || e > POWER_AT_MOST) return false;
  return key > 0
    ? digits >= least && digits < top
    : digits > least && digits <= top;
}

/** coarser is the key at `f` - 1 figures of the bucket `key` names at `f`. */
export function coarser(key: number, f: number): number {
  if (key === 0) return 0;
  const [offset, digits] = splitKey(key, f);
  const at = offset * DIGITS ** (f - 1);
  return key > 0
    ? at + Math.floor(digits / DIGITS)
    : -(at + Math.ceil(digits / DIGITS));
}

/** boundsOf is the low and high end of the bucket `key` names at `f` figures, within a double's reach. */
export function boundsOf(key: number, f: number): [number, number] {
  if (key === 0) return [0, 0];
  const [offset, digits] = splitKey(key, f);
  // A decimal read as a number is the double nearest it.
  const exponent = offset - EXPONENT_OFFSET - f + 1;
  const unit = (n: number) =>
    Math.min(Number(`${n}e${exponent}`), Number.MAX_VALUE);
  return key > 0
    ? [unit(digits), unit(digits + 1)]
    : [-unit(digits), -unit(digits - 1)];
}
