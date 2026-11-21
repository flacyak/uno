/**
 * @fileoverview The classes a heatmap wears an amount in: four equal steps
 * from zero up and four down, a round width, whole for counts, the largest
 * value always in the last, each value in the class whose break it reaches.
 */

import { expect, test } from "vite-plus/test";

import { CLASSES, classOf, classesOver } from "@renderer/chart/ramp";
import { RAMP_SHARES } from "@renderer/theme";

test("as many classes stand either side of zero as the ramp has steps", () => {
  expect(CLASSES).toBe(RAMP_SHARES.length);
});

test("counts up to 7 class in steps of 2, each up to its break", () => {
  const classes = classesOver([0, 1, 2, 3, 7], true);
  expect(classes).toStrictEqual({ width: 2, breaks: [2, 4, 6, 8] });
  expect([1, 2, 3, 4, 5, 7, 8].map((v) => classOf(v, classes))).toEqual([1, 1, 2, 2, 3, 4, 4]);
});

test("counts of 1 or 2 class in whole steps", () => {
  expect(classesOver([1], true).breaks).toEqual([1, 2, 3, 4]);
  expect(classesOver([2, 1], true).breaks).toEqual([1, 2, 3, 4]);
  expect(classesOver([1], false).breaks).toEqual([0.25, 0.5, 0.75, 1]);
});

test("sums either side of zero share one width, set by the one furthest from zero", () => {
  const classes = classesOver([-0.3, 1.1, 0.25], false);
  expect(classes.breaks).toEqual([0.3, 0.6, 0.9, 1.2]);
  expect([-0.3, 1.1, 0.25, -2].map((v) => classOf(v, classes))).toEqual([-1, 4, 1, -4]);
  expect(classesOver([-900, 10], false).breaks).toEqual([250, 500, 750, 1000]);
  expect(classesOver([-6.4, 11], false).breaks).toEqual([3, 6, 9, 12]);
});

test("the value furthest from zero always lands in the last class, at any size", () => {
  for (let most = 1; most <= 2_000; most++) {
    for (const scale of [1e-3, 1, 1e6]) {
      const value = most * scale;
      expect(classOf(value, classesOver([value], false)), `${value}`).toBe(CLASSES);
    }
  }
  // 100 rows a day class in steps of 25, where a step of 50 would leave two classes unworn.
  expect(classesOver([100, 4], true).breaks).toEqual([25, 50, 75, 100]);
});

test("a value on a break stays in the class under it, however a double writes it", () => {
  const classes = classesOver([0.4], false);
  // 3 tenths is written exactly, though 3 * 0.1 is 0.30000000000000004.
  expect(classes.breaks).toEqual([0.1, 0.2, 0.3, 0.4]);
  const tenths = [0.1, 0.2, 0.1 + 0.2, 0.3, 0.4];
  expect(tenths.map((v) => classOf(v, classes))).toEqual([1, 2, 3, 3, 4]);
});

test("zero is in no class either way, and a scale of zeros is one wide", () => {
  const classes = classesOver([0, 0], false);
  expect(classes.width).toBe(1);
  expect(classOf(0, classes)).toBe(0);
  expect(classesOver([], true).width).toBe(1);
});
