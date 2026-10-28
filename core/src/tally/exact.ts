/**
 * @fileoverview A sum with nothing rounded until it is read.
 */

// Whole UNITs are counted apart, and no partial reaches one, so no sum in
// add comes near the largest double, which is under 4 UNITs.
const UNIT_EXPONENT = 1022;
const UNIT = 2 ** UNIT_EXPONENT;
// Every double is a whole number of 2^-1074, the least subnormal.
const STEP_EXPONENT = -1074;
// Number() rounds a bigint to a double's 53 bits, ties to even. Those 53, one
// to round on, and one set when any bit below is set, round as the whole does.
const ROUNDING_BITS = 55;

/**
 * ExactSum adds finite numbers with no rounding, as Python's math.fsum does,
 * and rounds once, to the nearest double, when read. NaN and the infinities
 * throw a RangeError and change nothing, and no cell parses to one.
 */
export class ExactSum {
  /** Shewchuk's partials, smallest first and no two sharing a bit. */
  private readonly partials: number[] = [];
  /** How many partials hold the sum. Any past them are left over. */
  private count = 0;
  /** The whole UNITs the sum holds apart from its partials. */
  private units = 0;

  /** add adds `x`, exactly. */
  add(x: number): void {
    if (!Number.isFinite(x)) throw new RangeError('not a finite number');
    let top = this.carry(x);
    let kept = 0;
    for (let i = 0; i < this.count; i++) {
      // hi is the two added and rounded, and lo exactly what rounding lost.
      const p = this.partials[i]!;
      const swap = Math.abs(top) < Math.abs(p);
      const big = swap ? p : top;
      const small = swap ? top : p;
      const hi = big + small;
      const lo = small - (hi - big);
      if (lo !== 0) this.partials[kept++] = lo;
      top = hi;
    }
    top = this.carry(top);
    if (top !== 0) this.partials[kept++] = top;
    this.count = kept;
  }

  /** value is the sum rounded to the nearest double, ties to even. */
  value(): number {
    if (this.units !== 0) {
      let steps = BigInt(this.units) << BigInt(UNIT_EXPONENT - STEP_EXPONENT);
      for (let i = 0; i < this.count; i++) steps += stepsOf(this.partials[i]!);
      return nearest(steps);
    }
    // math.fsum's rounding: add from the largest partial down while exact. A
    // tie rounded to even goes the way the partials below lean instead.
    let n = this.count;
    if (n === 0) return 0;
    let hi = this.partials[--n]!;
    let lo = 0;
    while (n > 0) {
      const above = hi;
      const below = this.partials[--n]!;
      hi = above + below;
      lo = below - (hi - above);
      if (lo !== 0) break;
    }
    if (n > 0 && Math.sign(lo) === Math.sign(this.partials[n - 1]!)) {
      const away = hi + lo * 2;
      if (away - hi === lo * 2) hi = away;
    }
    return hi;
  }

  /** carry counts the whole UNITs in `x` and returns the rest, exactly. */
  private carry(x: number): number {
    const whole = Math.trunc(x / UNIT);
    this.units += whole;
    return x - whole * UNIT;
  }
}

/** stepsOf returns `x` as a whole number of 2^-1074. */
export function stepsOf(x: number): bigint {
  // Doubling is exact, and makes any double whole within 1074 times.
  let doublings = 0;
  for (; !Number.isInteger(x); doublings++) x *= 2;
  return BigInt(x) << BigInt(-STEP_EXPONENT - doublings);
}

/** nearest returns the double nearest `steps` of 2^-1074, ties to even. */
export function nearest(steps: bigint): number {
  const size = steps < 0n ? -steps : steps;
  const dropped = Math.max(size.toString(2).length - ROUNDING_BITS, 0);
  const kept = size >> BigInt(dropped);
  const sticky = kept << BigInt(dropped) === size ? 0n : 1n;
  const v = Number(kept | sticky) * 2 ** (dropped + STEP_EXPONENT);
  return steps < 0n ? -v : v;
}
