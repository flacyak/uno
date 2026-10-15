/**
 * @fileoverview A seeded random number generator for the tests that try many
 * random inputs. The same seed gives the same numbers, so a failure that
 * reports its seed can be run again.
 */

/** How many values a 32-bit unsigned integer takes. */
const UINT32_VALUES = 2 ** 32;

/** The odd constant mulberry32 adds to its state at each step. */
const STEP = 0x6d2b79f5;

/** A random number generator: numbers in [0, 1). */
export type Random = () => number;

/** random returns mulberry32 seeded with `seed`: numbers in [0, 1). */
export function random(seed: number): Random {
  let state = seed;
  return () => {
    state = (state + STEP) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_VALUES;
  };
}
