/**
 * @fileoverview ExactSum against sums with nothing rounded but the end.
 */

import { expect, test } from 'vite-plus/test';

import { ExactSum, nearest, stepsOf } from '@tally/exact';

function exact(xs: number[]): number {
  return nearest(xs.reduce((steps, x) => steps + stepsOf(x), 0n));
}

function summed(xs: number[]): ExactSum {
  const sum = new ExactSum();
  for (const x of xs) sum.add(x);
  return sum;
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
