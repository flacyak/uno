/**
 * @fileoverview The order statistics the lab summarizes runs with.
 */

import { expect, test } from 'vite-plus/test';

import {
  changePct,
  median,
  pairwiseAbsChangePct,
  quantile,
  summarize,
} from './stats.ts';

test('the median of an even count is halfway between the middle two', () => {
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([5, 1, 3])).toBe(3);
});

test('a quantile interpolates between ranks and keeps to 0 to 1', () => {
  expect(quantile([10, 20, 30, 40, 50], 0)).toBe(10);
  expect(quantile([10, 20, 30, 40, 50], 1)).toBe(50);
  expect(quantile([10, 20, 30, 40, 50], 0.9)).toBeCloseTo(46);
  expect(() => quantile([1], 2)).toThrow('outside 0 to 1');
  expect(() => quantile([], 0.5)).toThrow('no values');
});

test('a summary gives range and MAD relative to the median', () => {
  expect(summarize([90, 100, 110, 100, 130])).toEqual({
    n: 5,
    min: 90,
    median: 100,
    max: 130,
    rangePct: 40,
    madPct: 10,
  });
});

test('a change is positive when head is larger, even below zero', () => {
  expect(changePct(100, 105)).toBeCloseTo(5);
  expect(changePct(100, 90)).toBeCloseTo(-10);
  expect(changePct(-2, -1)).toBeCloseTo(50);
  expect(changePct(0, 3)).toBe(0);
});

test('pairwise changes cover every ordered pair of distinct runs', () => {
  const changes = pairwiseAbsChangePct([100, 110, 100]);
  expect(changes).toHaveLength(6);
  expect(changes.filter((c) => c === 0)).toHaveLength(2);
  expect(Math.max(...changes)).toBeCloseTo(10);
});
