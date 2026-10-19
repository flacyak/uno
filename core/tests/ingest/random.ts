/**
 * @fileoverview A seeded random number generator for the ingest tests that
 * check code over random input. The same seed gives the same input on every
 * run, so a failure reports its seed.
 */

/** What mulberry32 adds to its state for each number. */
const STEP = 0x6d2b79f5;
/** How many values a 32-bit unsigned integer takes. */
const UINT32_RANGE = 2 ** 32;

/** A random number generator: numbers in [0, 1). */
export type Random = () => number;

/** random returns mulberry32 over `seed`. */
export function random(seed: number): Random {
  return () => {
    seed = (seed + STEP) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}
