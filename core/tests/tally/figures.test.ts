/**
 * @fileoverview A number's bucket at some significant figures, against the
 * figures its cell wrote.
 */

import { expect, test } from 'vite-plus/test';

import { boundsOf, coarser, keyOf } from '@tally/figures';
import { seeded } from '@core-tests/lab/cache/stats';

const SEEDS = 200;
const FIGURES_AT_MOST = 12;
// Numbers over 40 decades, of up to 15 written figures, either side of zero.
const DECADES = 40;
const WRITTEN = 15;

/** bucket is the low and high end of the bucket `x` falls in at `f` figures. */
function bucket(x: number, f: number): [number, number] {
  return boundsOf(keyOf(x, f), f);
}

/** written is a random number as a cell writes it. */
function written(seed: number): number {
  const random = seeded(seed);
  const lead = Math.floor(random() * 10 ** WRITTEN);
  const e = Math.floor(random() * DECADES) - DECADES / 2;
  return Number(`${random() < 1 / 2 ? '-' : ''}${lead}e${e}`);
}

test('a bucket holds the figures a cell wrote, not those its double rounds to', () => {
  expect(bucket(2.3, 2)).toStrictEqual([2.3, 2.4]);
  expect(bucket(0.29, 2)).toStrictEqual([0.29, 0.3]);
  expect(bucket(2.2999999, 2)).toStrictEqual([2.2, 2.3]);
  expect(bucket(1204.5, 3)).toStrictEqual([1200, 1210]);
  expect(bucket(0.07, 1)).toStrictEqual([0.07, 0.08]);
});

test('a bucket below zero holds its low end, as one past zero does', () => {
  expect(bucket(-2.3, 2)).toStrictEqual([-2.3, -2.2]);
  expect(bucket(-2.25, 2)).toStrictEqual([-2.3, -2.2]);
  expect(bucket(-2.2, 2)).toStrictEqual([-2.2, -2.1]);
  expect(bucket(-100, 2)).toStrictEqual([-100, -99]);
  expect(bucket(0, 1)).toStrictEqual([0, 0]);
});

test('keys sort as their numbers do, and each bucket holds its number', () => {
  const xs = Array.from({ length: SEEDS }, (_, i) => written(i + 1));
  for (let f = 1; f <= FIGURES_AT_MOST; f++) {
    const keys = [...xs].sort((a, b) => a - b).map((x) => keyOf(x, f));
    expect(keys, `${f} figures`).toStrictEqual([...keys].sort((a, b) => a - b));
    for (const x of xs) {
      const [low, high] = bucket(x, f);
      expect(low <= x && x < high, `${x} at ${f} figures`).toBe(true);
    }
  }
});

test('a bucket at a figure fewer is the one that holds it', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const x = written(seed);
    for (let f = FIGURES_AT_MOST; f > 1; f--) {
      expect(coarser(keyOf(x, f), f), `${x} at ${f}`).toBe(keyOf(x, f - 1));
    }
  }
  expect(coarser(0, FIGURES_AT_MOST)).toBe(0);
});

test('a bucket at the ends of a double stays within its reach', () => {
  expect(bucket(1.7e308, 1)).toStrictEqual([1e308, Number.MAX_VALUE]);
  expect(bucket(-1.7e308, 1)).toStrictEqual([-Number.MAX_VALUE, -1e308]);
  // Past a double's least steps, a bucket's ends round to the number itself.
  const [low, high] = bucket(Number.MIN_VALUE, FIGURES_AT_MOST);
  expect([low, high]).toStrictEqual([Number.MIN_VALUE, Number.MIN_VALUE]);
  expect(Number.isSafeInteger(keyOf(Number.MAX_VALUE, FIGURES_AT_MOST))).toBe(
    true,
  );
});
