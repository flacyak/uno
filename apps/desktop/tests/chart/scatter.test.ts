/**
 * @fileoverview A scatter chart drawn from a tally: a point per sampled row,
 * where its x and y stand between the first and last ticks of axes that take
 * in every plotted row, over a gridline at each tick.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Sample } from "@engine";
import { axis } from "@renderer/chart/axes";
import { POINT_RADIUS, scatter } from "@renderer/chart/scatter";

/** A tally that sent `x` and `y` and plotted no other row. */
function sampleOf(x: number[], y: number[]): Sample {
  const least = { x: Math.min(...x), y: Math.min(...y) };
  const most = { x: Math.max(...x), y: Math.max(...y) };
  return { x, y, plotted: x.length, least, most, skipped: { blank: 0, unparsed: 0 } };
}

/** Units against revenue: x ticks 0 to 200 by 50, and y 0 to 4,000 by 1,000. */
const SALES = sampleOf([0, 50, 200], [0, 3000, 4000]);

/** The attribute `name` of each of `box`'s `selector`. */
const read = (box: HTMLElement, selector: string, name: string): Array<string | null> =>
  [...box.querySelectorAll(selector)].map((at) => at.getAttribute(name));

test("a point stands where its x and y fall between each axis's first tick and its last", () => {
  const box = scatter(SALES);
  expect(read(box, ".chart-point", "cx")).toStrictEqual(["0%", "25%", "100%"]);
  expect(read(box, ".chart-point", "cy")).toStrictEqual(["100%", "25%", "0%"]);
  expect(read(box, ".chart-point", "r")).toStrictEqual(SALES.x.map(() => `${POINT_RADIUS}`));
});

test("the axes take in every plotted row, not only the rows the tally sent", () => {
  const sent = { ...sampleOf([50], [1000]), plotted: 4812 };
  const box = scatter({ ...sent, least: { x: -100, y: 0 }, most: { x: 100, y: 4000 } });
  expect(read(box, ".chart-point", "cx")).toStrictEqual(["75%"]);
  expect(read(box, ".chart-point", "cy")).toStrictEqual(["75%"]);
});

test("a gridline crosses the plot at each tick of either axis, under the points", () => {
  const box = scatter(SALES);
  const ticks = ["0%", "25%", "50%", "75%", "100%"];
  expect(read(box, ".chart-grid.x", "x1")).toStrictEqual(ticks);
  expect(read(box, ".chart-grid.x", "y2")).toStrictEqual(ticks.map(() => "100%"));
  expect(read(box, ".chart-grid.y", "y1")).toStrictEqual(ticks.toReversed());
  expect(read(box, ".chart-grid.y", "x2")).toStrictEqual(ticks.map(() => "100%"));
  expect(box.querySelector(".chart-grid ~ .chart-point")).not.toBeNull();
  expect(box.querySelector(".chart-point ~ .chart-grid")).toBeNull();
});

test("a tally that plotted nothing draws nothing, as its extent of 0 is no row's", () => {
  const none = { ...sampleOf([0], [0]), x: [], y: [], plotted: 0 };
  expect(scatter(none).childElementCount).toBe(0);
});

test("an axis no double can scale draws nothing, where its points would stand at NaN", () => {
  // A span past what a double holds gives no ticks to scale by.
  const wide = sampleOf([-9e307, 9e307], [0, 1]);
  expect(axis(wide.least.x, wide.most.x).ticks.length).toBeLessThan(2);
  expect(scatter(wide).childElementCount).toBe(0);
  // Ticks a double holds can still lie further apart than one does.
  const far = sampleOf([-8e307, 8e307], [0, 1]);
  expect(axis(far.least.x, far.most.x).ticks.every(Number.isFinite)).toBe(true);
  expect(scatter(far).childElementCount).toBe(0);
});
