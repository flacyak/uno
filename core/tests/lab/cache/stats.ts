/**
 * @fileoverview Small numeric helpers for the cache lab: the minimum and
 * median of a list, a seeded random number source so every run picks the same
 * rows, and a shuffle that uses it.
 */

/** The smallest and the middle value of some samples. */
export interface Spread {
  min: number;
  median: number;
}

/** Returns the smallest value. Throws for an empty list. */
export function min(values: readonly number[]): number {
  if (values.length === 0) throw new Error('min of zero values');
  return Math.min(...values);
}

/** Returns the median: the middle value, or the mean of the two middle ones. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of zero values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Returns the min and median of the samples. */
export function spread(values: readonly number[]): Spread {
  return { min: min(values), median: median(values) };
}

/** Digits kept after the decimal point in reported numbers. */
const DECIMALS = 3;
const ROUNDING = 10 ** DECIMALS;

/** Rounds to DECIMALS places, so the JSON stays readable. */
export function rounded(value: number): number {
  return Math.round(value * ROUNDING) / ROUNDING;
}

/** Rounds both halves of a Spread. */
export function roundedSpread(s: Spread): Spread {
  return { min: rounded(s.min), median: rounded(s.median) };
}

/** A function returning uniform numbers in [0, 1). */
export type Random = () => number;

// The constants of mulberry32, a small 32-bit generator with a full period.
const MULBERRY_STEP = 0x6d2b79f5;
const MULBERRY_SHIFT_A = 15;
const MULBERRY_SHIFT_B = 7;
const MULBERRY_SHIFT_C = 14;
const MULBERRY_MIX = 61;
/** 2 to the 32nd, to turn a 32-bit integer into a fraction. */
const UINT32_RANGE = 2 ** 32;

/** seeded returns a generator that yields the same numbers for the same seed. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_STEP) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> MULBERRY_SHIFT_A), t | 1);
    t ^= t + Math.imul(t ^ (t >>> MULBERRY_SHIFT_B), t | MULBERRY_MIX);
    return ((t ^ (t >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32_RANGE;
  };
}

/** shuffled returns a copy of `items` in a random order (Fisher-Yates). */
export function shuffled<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
