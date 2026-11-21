/**
 * @fileoverview A heatmap over periods' drawing: the finest size whose cells
 * fit, a row per value largest first, each cell in the class of its rows or
 * sum either side of zero, a period of no rows in no class, and a line that
 * counts the values left out.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { HeatPlot } from "@document";
import type { HeatTally } from "@engine";
import { HEAT_ROWS_AT_MOST, heatGrid, heatLevel, heatTargets } from "@renderer/chart/heat";
import { heat } from "@renderer/chart/kinds/heat";
import type { SplitLevel } from "@tally";

const BY = { col: 1, header: "region" };
const AT = { col: 0, header: "ordered" };
const PLOT: HeatPlot = { t: "heat", by: BY, at: AT, per: "auto", order: "day" };
const ROOM = { width: 420, ch: 7 };
const TALL = 400;
/** 2024-03-04, a day key, and its month's. */
const DAY = 19_786;
const MONTH = 650;

/** A tally of values with these rows per month, and 90 days of each spread one a day. */
function tallyOf(months: number[][], sums: number[][] = []): HeatTally {
  const values = months.map((rows, i) => ({
    value: `r${i}`,
    rows: rows.reduce((a, b) => a + b, 0),
    sum: 0,
    undated: { rows: 0, sum: 0 },
    unsplit: { rows: 0, sum: 0 },
  }));
  const days: SplitLevel = {
    per: "day",
    from: DAY,
    span: 90,
    rows: months.map(() => Array.from({ length: 90 }, () => 1)),
    sum: [],
  };
  const month: SplitLevel = { per: "month", from: MONTH, span: 3, rows: months, sum: sums };
  return {
    t: "heat",
    plot: PLOT,
    coverage: { rows: 9, total: 9, complete: true },
    values,
    levels: [days, month],
    others: { values: 0, rows: 0, sum: 0 },
    dates: { blank: 0, unparsed: 0, other: 0 },
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** Each row's cells' fills, '' for none. */
const fillsOf = (drawn: HTMLElement): string[][] =>
  [...drawn.querySelectorAll(".chart-heat-cells")].map((cells) =>
    [...cells.querySelectorAll<HTMLElement>(".chart-heat-cell")].map((c) =>
      c.style.getPropertyValue("--fill"),
    ),
  );

test("a heatmap draws the finest size whose cells get 6 px, a row per value, each cell in its class", () => {
  const tally = tallyOf([
    [8, 0, 2],
    [1, 4, 0],
  ]);
  // 90 days need 540 px, more than a 420 px window has; 3 months fit.
  const level = heatLevel(tally, ROOM)!;
  expect(level.per).toBe("month");
  expect(heatLevel(tally, { ...ROOM, width: 1_000 })!.per).toBe("day");
  const drawn = heatGrid(tally, level, false, ROOM, TALL);
  expect(fillsOf(drawn)).toEqual([
    ["var(--seq-4)", "", "var(--seq-1)"],
    ["var(--seq-1)", "var(--seq-2)", ""],
  ]);
  expect([...drawn.querySelectorAll(".chart-bar-label")].map((l) => l.textContent)).toEqual([
    "r0",
    "r1",
  ]);
  expect(drawn.querySelector(".chart-bars-line")).toBeNull();
});

test("a heatmap of sums draws a period below zero in the pole's class", () => {
  const tally = tallyOf([[1, 1, 1]], [[-300, 0, 400]]);
  const drawn = heatGrid(tally, tally.levels[1]!, true, ROOM, TALL);
  expect(fillsOf(drawn)).toEqual([["var(--div-3)", "", "var(--seq-4)"]]);
});

test("a heatmap draws at most twelve rows, fewer where the plot is short, and counts the values left out", () => {
  const tally = tallyOf(Array.from({ length: HEAT_ROWS_AT_MOST + 2 }, () => [1, 1, 1]));
  const tall = heatGrid(tally, tally.levels[1]!, false, ROOM, 1_000);
  expect(fillsOf(tall)).toHaveLength(HEAT_ROWS_AT_MOST);
  expect(tall.querySelector(".chart-bars-line")?.textContent).toBe("+2 more · 6 rows");
  const short = heatGrid(tally, tally.levels[1]!, false, ROOM, 160);
  expect(fillsOf(short).length).toBeLessThan(HEAT_ROWS_AT_MOST);
  expect(heat(PLOT).drawing({ ...tally, levels: [] }, ROOM)?.empty).toBe(true);
});

test("a heatmap's cells each say their value, their period and what they hold, and the keys step along a value and across values", () => {
  const tally = tallyOf(
    [
      [8, 0, 2],
      [1, 4, 0],
    ],
    [
      [80, 0, -20],
      [10, 40, 0],
    ],
  );
  const level = tally.levels[1]!;
  const targets = heatTargets(tally, level, true, heatGrid(tally, level, true, ROOM, TALL));
  const said = (n: number) =>
    targets.all[n]!.said()
      .map(({ value, label }) => `${value} ${label.textContent}`)
      .join(" / ");
  expect(said(2)).toBe("-20 r0, May 2024 / 2 rows");
  expect(said(4)).toBe("40 r1, April 2024 / 4 rows");
  const step = (key: string, at: number | undefined) => targets.step!(key, at);
  expect([
    step("ArrowRight", undefined),
    step("ArrowRight", 2),
    step("ArrowDown", 1),
    step("End", 3),
  ]).toEqual([0, 2, 4, 5]);
  expect(targets.keys).toEqual(["ArrowDown", "ArrowUp"]);
});
