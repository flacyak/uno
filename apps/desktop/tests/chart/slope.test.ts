/**
 * @fileoverview A slope chart's rows: each value's two ends as the chart
 * measures them, the first SLOPES_AT_MOST of them, and the rest counted; and
 * a line per value between its ends, on one scale over both.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { SlopePlot } from "@document";
import type { SlopeTally } from "@engine";
import { SLOPES_AT_MOST, sloped, slopes } from "@renderer/chart/slope";
import type { Ended } from "@tally";

const REGION = { col: 0, header: "region" };
const YEAR = { col: 1, header: "year" };
const REVENUE = { col: 2, header: "revenue" };
const ROWS: SlopePlot = { t: "slope", by: REGION, between: YEAR, from: "2024", to: "2025" };
const SUMS: SlopePlot = { ...ROWS, of: REVENUE, measure: "sum" };

/** An end of `sum` over `rows` rows, `numbers` of them numbers. */
const end = (sum: number, rows: number, numbers = rows): Ended => ({ rows, sum, numbers });
const NONE = end(0, 0);

/** A tally of values, each with its two ends. */
function tallyOf(values: Array<[string, Ended, Ended]>, plot = SUMS): SlopeTally {
  return {
    t: "slope",
    plot,
    coverage: { rows: 10, total: 10, complete: true },
    values: values.map(([value, from, to]) => ({ value, ends: [from, to], unsplit: false })),
    others: { values: 0, rows: 0 },
    rest: { rows: 0, sum: 0 },
    skipped: { blank: 0, unparsed: 0 },
  };
}

test("a slope's rows stand at each end's rows, sum or mean, none at an end of no rows or no number", () => {
  const tally = tallyOf([
    ["East", end(10, 2), end(30, 3, 2)],
    ["West", end(40, 1, 0), NONE],
  ]);
  const ends = (plot: SlopePlot) => sloped(plot, { ...tally, plot }).rows.map((r) => r.ends);
  expect(ends(ROWS)).toStrictEqual([
    [2, 3],
    [1, undefined],
  ]);
  expect(ends(SUMS)).toStrictEqual([
    [10, 30],
    [40, undefined],
  ]);
  expect(ends({ ...SUMS, measure: "mean" })).toStrictEqual([
    [5, 15],
    [undefined, undefined],
  ]);
  expect(sloped(SUMS, tally).states).toStrictEqual(["2024", "2025"]);
});

test("a slope's rows are its first SLOPES_AT_MOST values, the rest counted with those the tally sent none of, and a value of rows apart from its states stands nowhere", () => {
  const values = Array.from({ length: SLOPES_AT_MOST + 2 }, (_, i): [string, Ended, Ended] => [
    `v${i}`,
    end(i, 1),
    end(i, 1),
  ]);
  const tally = { ...tallyOf(values), others: { values: 3, rows: 7 } };
  tally.values[0] = { ...tally.values[0]!, unsplit: true };
  const { rows, more } = sloped(SUMS, tally);
  expect(rows).toHaveLength(SLOPES_AT_MOST);
  expect(rows[0]!.ends).toStrictEqual([undefined, undefined]);
  expect(more).toBe(5);
});

/** Where `drawn`'s marks of class `cls` stand up the plot, as thirds of it from its foot. */
const thirds = (drawn: Element, cls: string, at: "y1" | "y2" | "cy") =>
  [...drawn.querySelectorAll(`.${cls}`)].map((mark) =>
    Math.round((1 - parseFloat(mark.getAttribute(at)!) / 100) * 3),
  );

test("a slope's lines run from each value's From end to its To end on one scale over both, a dot at each end over every line", () => {
  const tally = tallyOf([
    ["East", end(10, 1), end(30, 1)],
    ["West", end(40, 1), end(20, 1)],
  ]);
  // 10 to 40 on an axis of 10 to 40.
  const drawn = slopes(sloped(SUMS, tally));
  expect(thirds(drawn, "chart-slope-line", "y1")).toStrictEqual([0, 3]);
  expect(thirds(drawn, "chart-slope-line", "y2")).toStrictEqual([2, 1]);
  const dots = [...drawn.querySelectorAll("svg > *")].slice(-4);
  expect(dots.every((dot) => dot.classList.contains("chart-slope-dot"))).toBe(true);
});

test("a value with rows at one end only draws its one dot and no line, and one standing nowhere draws nothing", () => {
  const tally = tallyOf([
    ["East", end(10, 1), NONE],
    ["West", end(20, 1, 0), end(40, 1)],
  ]);
  const drawn = slopes(sloped({ ...SUMS, measure: "mean" }, tally));
  expect(drawn.querySelectorAll(".chart-slope-line")).toHaveLength(0);
  expect(thirds(drawn, "chart-slope-dot", "cy")).toStrictEqual([0, 3]);
});
