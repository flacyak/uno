/**
 * @fileoverview A scatter chart drawn from a tally: a point per sampled row,
 * where its x and y stand between the first and last ticks of axes that take
 * in every plotted row.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Sample } from "@engine";
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
