/**
 * @fileoverview A sum with nothing rounded until it is read.
 */

/**
 * ExactSum adds finite numbers with no rounding, as Python's math.fsum does,
 * and rounds once, to the nearest double, when read.
 */
export class ExactSum {
  /** Shewchuk's partials, smallest first and no two sharing a bit. */
  private readonly partials: number[] = [];
  /** How many partials hold the sum. Any past them are left over. */
  private count = 0;

  /** add adds `x`, exactly. */
  add(x: number): void {
    let top = x;
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
    if (top !== 0) this.partials[kept++] = top;
    this.count = kept;
  }

  /** value is the sum rounded to the nearest double, ties to even. */
  value(): number {
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
}
