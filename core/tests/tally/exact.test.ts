/**
 * @fileoverview ExactSum against sums with nothing rounded but the end.
 */

import { expect, test } from 'vite-plus/test';

import { ExactSum } from '@tally';

function summed(xs: number[]): ExactSum {
  const sum = new ExactSum();
  for (const x of xs) sum.add(x);
  return sum;
}

test('an exact sum reads as its numbers added exactly and rounded once', () => {
  const known: Array<[number[], number]> = [
    [Array<number>(10).fill(0.1), 1],
    [[1e-300, 1e300, -1e300], 1e-300],
    // Subnormals beside the least normal double.
    [[2 ** -1074, 2 ** -1022, -(2 ** -1073)], 2 ** -1022 - 2 ** -1074],
    // Halfway between 1e16 and the next double, pushed up by 1e-16.
    [[1e-16, 1, 1e16], 10000000000000002],
  ];
  for (const [xs, want] of known) {
    const list = xs.join(', ');
    expect(summed(xs).value(), list).toBe(want);
    expect(summed(xs.toReversed()).value(), `${list} reversed`).toBe(want);
  }
});
