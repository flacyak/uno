/**
 * @fileoverview An axis's ticks: 1, 2 or 5 times a power of ten apart, from at
 * or below the least value to at or above the most, each the decimal it stands
 * for.
 */

import { expect, test } from "vite-plus/test";

import { axis } from "@renderer/chart/axes";

test("a column of 4,812 rows ticks every 2,000, past its most", () => {
  expect(axis(0, 4_812).ticks).toEqual([0, 2_000, 4_000, 6_000]);
});

test("a tick is the decimal it stands for, and none stands a step short of the least", () => {
  expect(axis(0.3, 0.6).ticks).toEqual([0.3, 0.4, 0.5, 0.6]);
});

test("an axis over one value runs from zero to twice it", () => {
  expect(axis(5, 5).ticks).toEqual([0, 5, 10]);
  expect(axis(-3, -3).ticks).toEqual([-6, -4, -2, 0]);
  expect(axis(0, 0).ticks).toEqual([-1, 0, 1]);
});

test("an axis over values a double barely tells apart runs as over one of them", () => {
  expect(axis(0.1, 0.10000000000000002).ticks).toEqual([0, 0.1, 0.2]);
  expect(axis(1.1, 1.1000000000000003).ticks).toEqual([0, 1, 2, 3]);
  expect(axis(100.1, 100.10000000000001).ticks).toEqual([0, 100, 200, 300]);
});
