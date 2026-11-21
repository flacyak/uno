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
import { SLOPES_AT_MOST, slopeTargets, sloped, slopes } from "@renderer/chart/slope";
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
  // Each value's dots stand in its group, after every line.
  const groups = [...drawn.querySelectorAll("svg > *")].slice(-2);
  expect(groups.every((g) => g.matches(".chart-slope-value:has(.chart-slope-dot)"))).toBe(true);
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

test("a slope names its states over its ends, as wide as their names, and a line counts the values left out", () => {
  const values = Array.from({ length: SLOPES_AT_MOST + 1 }, (_, i): [string, Ended, Ended] => [
    `v${i}`,
    end(i, 1),
    end(i, 1),
  ]);
  const drawn = slopes(sloped({ ...SUMS, to: "2025 plan" }, tallyOf(values)));
  const states = [...drawn.querySelectorAll(".chart-slope-state")].map((s) => s.textContent);
  expect(states).toStrictEqual(["2024", "2025 plan"]);
  const wides = ["--from-wide", "--to-wide"].map((at) => drawn.style.getPropertyValue(at));
  expect(wides).toStrictEqual(["4ch", "9ch"]);
  expect(drawn.querySelector(".chart-bars-line")?.textContent).toBe("+1 more");
});

test("a slope's From ends say their numbers at their left and its To ends their names and numbers at their right, each side as wide as its widest", () => {
  const drawn = slopes(
    sloped(
      SUMS,
      tallyOf([
        ["", end(0, 1), end(0, 1)],
        ["West", end(10, 1), NONE],
        ["A name longer than any key's", end(200, 1), end(5, 1)],
      ]),
    ),
  );
  const texts = (side: string) =>
    [...drawn.querySelectorAll(`.chart-slope-ends.${side} > *`)].map((at) => at.textContent);
  expect(texts("from")).toStrictEqual(["0", "10", "200"]);
  // West has no To end, and the blank value reads as the app's word for one.
  expect(texts("to")).toStrictEqual(["(blank) 0", "A name longer than any key's 5"]);
  const blank = drawn.querySelector<HTMLElement>(".chart-slope-ends.to > *")!;
  expect([blank.title, blank.style.top]).toStrictEqual(["(blank)", "100%"]);
  const wides = ["--from-wide", "--to-wide"].map((at) => drawn.style.getPropertyValue(at));
  expect(wides).toStrictEqual(["4ch", "20ch"]);
});

test("a slope's value says its change as a share, named, and each end in its state; Down and Up step the values; the pointer finds the nearest line", () => {
  const drawing = sloped(
    SUMS,
    tallyOf([
      ["East", end(10, 1), end(30, 1)],
      ["West", end(40, 1), NONE],
    ]),
  );
  const drawn = slopes(drawing);
  const targets = slopeTargets(drawing, drawn);
  const said = (i: number) =>
    targets.all[i]!.said().map((r) => `${r.value} ${r.label.textContent}`.trim());
  expect(said(0)).toStrictEqual(["+200% East", "10 in 2024", "30 in 2025"]);
  expect(said(1)).toStrictEqual(["West", "40 in 2024", "none in 2025"]);
  expect([
    targets.step!("ArrowDown", undefined),
    targets.step!("ArrowUp", undefined),
  ]).toStrictEqual([0, 1]);
  // A plot 100 px square at the page's corner: East runs from its foot up to a third from its top.
  const plot = drawn.querySelector(".chart-slope-plot")!;
  plot.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
  expect(targets.under(plot, 50, 70)).toBe(0);
  expect(targets.under(plot, 10, 4)).toBe(1);
  expect(targets.under(plot, 50, 2)).toBeUndefined();
});
