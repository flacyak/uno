/**
 * @fileoverview ExactSum against sums with nothing rounded but the end.
 */

import { expect, test } from 'vite-plus/test';

import { ExactSum, nearest, stepsOf } from '@tally/exact';
import { UINT32_RANGE, seeded } from '@core-tests/lab/cache/stats';

// Enough lists, and long enough, that about one list of random bits in 20
// holds a number of 2^1022 or more, which a read takes through the carry.
const SEEDS = 200;
const DRAWS = 48;
const HALF = DRAWS / 2;
// Amounts of up to a million in whole cents, as a column of prices holds.
const CENTS = 100;
const MOST_CENTS = 1e8;

function exact(xs: number[]): number {
  return nearest(xs.reduce((steps, x) => steps + stepsOf(x), 0n));
}

function summed(xs: number[]): ExactSum {
  const sum = new ExactSum();
  for (const x of xs) sum.add(x);
  return sum;
}

/** bits returns doubles of every size and sign, from random bits. */
function bits(seed: number): number[] {
  const random = seeded(seed);
  const doubles = new Float64Array(DRAWS);
  const words = new Uint32Array(doubles.buffer);
  for (let i = 0; i < words.length; i++) words[i] = random() * UINT32_RANGE;
  return [...doubles].filter(Number.isFinite);
}

/** cents returns amounts of either sign, whose sum a running total rounds. */
function cents(seed: number): number[] {
  const random = seeded(seed);
  const amount = () => Math.round((random() * 2 - 1) * MOST_CENTS) / CENTS;
  return Array.from({ length: DRAWS }, amount);
}

test('an exact sum reads as its numbers added exactly and rounded once', () => {
  // Each is under 2^1022, and the first six add up past the largest double.
  const big = 0.75 * 2 ** 1022;
  const known: Array<[number[], number]> = [
    [Array<number>(10).fill(0.1), 1],
    [[1e-300, 1e300, -1e300], 1e-300],
    // Subnormals beside the least normal double.
    [[2 ** -1074, 2 ** -1022, -(2 ** -1073)], 2 ** -1022 - 2 ** -1074],
    // Halfway between 1e16 and the next double, pushed up by 1e-16.
    [[1e-16, 1, 1e16], 10000000000000002],
    [[1e308, 1, -1e308], 1],
    [[1e308, 1e308, -1e308, -1e308, 1e308], 1e308],
    [[big, big, big, big, big, big, -big, -big, -big], 3 * big],
    // Halfway past the largest double rounds to even, which is too large.
    [[-Number.MAX_VALUE, -(2 ** 970)], -Infinity],
    [[Number.MAX_VALUE, 2 ** 970, -(2 ** -1074)], Number.MAX_VALUE],
  ];
  for (const [xs, want] of known) {
    const list = xs.join(', ');
    expect(exact(xs), list).toBe(want);
    expect(summed(xs).value(), list).toBe(want);
    expect(summed(xs.toReversed()).value(), `${list} reversed`).toBe(want);
  }
});

test('an exact sum refuses what is not a finite number', () => {
  const sum = summed([0.1, 0.2]);
  for (const x of [NaN, Infinity, -Infinity]) {
    expect(() => sum.add(x)).toThrow(RangeError);
  }
  expect(sum.value()).toBe(0.30000000000000004);
});

test('an exact sum reads the same however its numbers came to it', () => {
  for (const draw of [bits, cents]) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const label = `${draw.name} ${seed}`;
      const xs = draw(seed);
      const merged = summed(xs.slice(HALF));
      merged.merge(summed(xs.slice(0, HALF)));
      const takenBack = summed([...draw(-seed), ...xs]);
      for (const x of draw(-seed)) takenBack.remove(x);
      for (const sum of [summed(xs), merged, takenBack]) {
        expect(sum.value(), label).toBe(exact(xs));
      }
      merged.merge(merged);
      expect(merged.value(), `${label} twice`).toBe(exact([...xs, ...xs]));
    }
  }
});
