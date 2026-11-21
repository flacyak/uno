/**
 * @fileoverview A week heatmap's drawing: a cell per hour of the week, Sunday
 * 00:00 first, each in the class of its rows or its sum, either side of zero,
 * and an hour of no rows in no class.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { WeekPlot } from "@document";
import type { WeekTally } from "@engine";
import { week } from "@renderer/chart/kinds/week";
import { weekGrid } from "@renderer/chart/week";
import { DAY_HOURS, WEEK_HOURS } from "@tally";

const AT = { col: 0, header: "ordered" };
const REVENUE = { col: 1, header: "revenue" };
const ROWS: WeekPlot = { t: "week", at: AT, order: "day" };
const SUMS: WeekPlot = { ...ROWS, sum: REVENUE };
const ROOM = { width: 420, ch: 7 };
const MONDAY_NINE = DAY_HOURS + 9;

/** A tally of `plot` whose hours hold `held`, by hour of the week, and none else. */
function tallyOf(plot: WeekPlot, held: Record<number, [number, number]>): WeekTally {
  const hours = Array.from({ length: WEEK_HOURS }, (_, i) => {
    const [rows, sum] = held[i] ?? [0, 0];
    return { rows, sum };
  });
  return {
    t: "week",
    plot,
    coverage: { rows: 10, total: 10, complete: true },
    hours,
    timed: 10,
    undated: { rows: 0, sum: 0 },
    dates: { blank: 0, unparsed: 0, other: 0 },
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** The class each cell of a drawing wears, '' for none, Sunday 00:00 first. */
const stepsOf = (drawn: HTMLElement): string[] =>
  [...drawn.querySelectorAll<HTMLElement>(".chart-week-cell")].map((c) => c.dataset["step"] ?? "");

test("a week heatmap draws a cell per hour of the week, each in the class of its rows", () => {
  const tally = tallyOf(ROWS, { 0: [1, 0], [MONDAY_NINE]: [7, 0], [WEEK_HOURS - 1]: [4, 0] });
  const steps = stepsOf(weekGrid(tally, false));
  expect(steps).toHaveLength(WEEK_HOURS);
  // Steps of 2 up to 8: 1 is in the first, 4 in the second and 7 in the fourth.
  expect(steps[0]).toBe("1");
  expect(steps[MONDAY_NINE]).toBe("4");
  expect(steps.at(-1)).toBe("2");
  expect(steps.filter((s) => s === "")).toHaveLength(WEEK_HOURS - 3);
});

test("a week heatmap of sums draws an hour below zero in the pole's class, and one of zero in neither", () => {
  const tally = tallyOf(SUMS, { 0: [2, -300], 1: [1, 0], [MONDAY_NINE]: [5, 400] });
  const steps = stepsOf(weekGrid(tally, true));
  expect([steps[0], steps[1], steps[MONDAY_NINE], steps[2]]).toEqual(["-3", "0", "4", ""]);
  const fills = [...weekGrid(tally, true).querySelectorAll<HTMLElement>(".chart-week-cell")].map(
    (c) => c.style.getPropertyValue("--fill"),
  );
  expect([fills[0], fills[1], fills[MONDAY_NINE], fills[2]]).toEqual([
    "var(--div-3)",
    "",
    "var(--seq-4)",
    "",
  ]);
});

test("a week heatmap's kind draws its tally, and one of no dated row is empty", () => {
  const tally = tallyOf(SUMS, { [MONDAY_NINE]: [5, 400] });
  const drawing = week(SUMS).drawing(tally, ROOM)!;
  expect(stepsOf(drawing.draw(0))[MONDAY_NINE]).toBe("4");
  expect(week(SUMS).drawing(tallyOf(SUMS, {}), ROOM)?.empty).toBe(true);
});
