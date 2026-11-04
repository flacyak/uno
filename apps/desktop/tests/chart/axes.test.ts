/**
 * @fileoverview An axis's ticks: 1, 2 or 5 times a power of ten apart, 3 to 5
 * of them, from at or below the least value to at or above the most, each the
 * decimal it stands for.
 */

import { expect, test } from "vite-plus/test";

import { axis } from "@renderer/chart/axes";

/** The fewest and most ticks an axis takes. */
const TICKS_LEAST = 3;
const TICKS_MOST = 5;

/** The powers of ten a span runs over below: a ten-millionth to a trillion. */
const POWER_LEAST = -7;
const POWER_MOST = 12;

/** A span's leading digits: on each step, between them, and a column's 4,812 rows. */
const LEADS = [1, 1.5, 2, 3.1, 4.812, 5, 7, 9.5];

/** Where a span starts, in spans from zero: at, across, below, above and far above zero. */
const STARTS = [0, -0.5, -1, 3.7, 1000];

/** The digits a double holds for certain, so a decimal written to them reads as itself. */
const SURE_DIGITS = 15;

/** How far a step or an end may stray, in steps: a double's error, far short of a step. */
const STRAY = 1e-6;

test("an axis ticks 3 to 5 times, 1, 2 or 5 times a power of ten apart, over every value", () => {
  for (let power = POWER_LEAST; power <= POWER_MOST; power++) {
    for (const span of LEADS.map((lead) => lead * 10 ** power)) {
      for (const low of STARTS.map((start) => start * span)) {
        const high = low + span;
        const { ticks } = axis(low, high);
        const said = `${low} to ${high}: ${ticks.join(", ")}`;
        const step = ticks[1]! - ticks[0]!;
        const lead = step.toExponential(0);
        expect(ticks.length, said).toBeGreaterThanOrEqual(TICKS_LEAST);
        expect(ticks.length, said).toBeLessThanOrEqual(TICKS_MOST);
        expect(["1", "2", "5"].includes(lead[0]!), said).toBe(true);
        expect(Math.abs(Number(lead) - step), said).toBeLessThan(step * STRAY);
        // A value a double's error past a tick stands on it.
        expect(ticks[0]! - low, said).toBeLessThan(step * STRAY);
        expect(high - ticks.at(-1)!, said).toBeLessThan(step * STRAY);
        const loose = ticks.filter((tick) => Number(tick.toPrecision(SURE_DIGITS)) !== tick);
        expect(loose, said).toEqual([]);
      }
    }
  }
});

test("a column of 4,812 rows ticks every 2,000, past its most", () => {
  expect(axis(0, 4_812).ticks).toEqual([0, 2_000, 4_000, 6_000]);
});

test("an axis ticks by the finer step where 5 ticks reach its most, to fill more of it", () => {
  // By 5, both would run to 10, and leave up to two fifths of it empty.
  expect(axis(0, 7.5).ticks).toEqual([0, 2, 4, 6, 8]);
  expect(axis(0, 6.01).ticks).toEqual([0, 2, 4, 6, 8]);
});

test("a tick is the decimal it stands for, and none stands a step short of the least", () => {
  expect(axis(0.3, 0.6).ticks).toEqual([0.3, 0.4, 0.5, 0.6]);
});

test("an axis over one value runs from zero to twice it", () => {
  expect(axis(5, 5).ticks).toEqual([0, 5, 10]);
  expect(axis(-3, -3).ticks).toEqual([-6, -4, -2, 0]);
  expect(axis(0, 0).ticks).toEqual([-1, -0.5, 0, 0.5, 1]);
});

test("an axis over values a double barely tells apart runs as over one of them", () => {
  expect(axis(0.1, 0.10000000000000002).ticks).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
  expect(axis(1.1, 1.1000000000000003).ticks).toEqual([0, 1, 2, 3]);
  expect(axis(100.1, 100.10000000000001).ticks).toEqual([0, 100, 200, 300]);
});
