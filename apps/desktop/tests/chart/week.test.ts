/**
 * @fileoverview A week heatmap's drawing: a cell per hour of the week, Sunday
 * 00:00 first, each in the class of its rows or its sum, either side of zero,
 * and an hour of no rows in no class.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { WeekPlot } from "@document";
import type { WeekTally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { week } from "@renderer/chart/kinds/week";
import { hourStep, weekGrid, weekTargets } from "@renderer/chart/week";
import { DAY_HOURS, WEEK_HOURS } from "@tally";

const AT = { col: 0, header: "ordered" };
const REVENUE = { col: 1, header: "revenue" };
const ROWS: WeekPlot = { t: "week", at: AT, order: "day" };
const SUMS: WeekPlot = { ...ROWS, sum: REVENUE };
const ROOM = { width: 420, ch: 7 };
/** The least width a window takes, and its plot. */
const LEAST = { width: 240, ch: 7 };

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});
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
  const steps = stepsOf(weekGrid(tally, false, ROOM));
  expect(steps).toHaveLength(WEEK_HOURS);
  // Steps of 2 up to 8: 1 is in the first, 4 in the second and 7 in the fourth.
  expect(steps[0]).toBe("1");
  expect(steps[MONDAY_NINE]).toBe("4");
  expect(steps.at(-1)).toBe("2");
  expect(steps.filter((s) => s === "")).toHaveLength(WEEK_HOURS - 3);
});

test("a week heatmap of sums draws an hour below zero in the pole's class, and one of zero in neither", () => {
  const tally = tallyOf(SUMS, { 0: [2, -300], 1: [1, 0], [MONDAY_NINE]: [5, 400] });
  const steps = stepsOf(weekGrid(tally, true, ROOM));
  expect([steps[0], steps[1], steps[MONDAY_NINE], steps[2]]).toEqual(["-3", "0", "4", ""]);
  const fills = [
    ...weekGrid(tally, true, ROOM).querySelectorAll<HTMLElement>(".chart-week-cell"),
  ].map((c) => c.style.getPropertyValue("--fill"));
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

test("a week heatmap names its days from Sunday beside its rows, and its hours under its columns as many as stand apart", () => {
  const texts = (drawn: HTMLElement, at: string): string[] =>
    // Node's ICU writes a space before AM where Chromium's writes a narrow one.
    [...drawn.querySelectorAll(`${at} .chart-tick`)].map((t) =>
      (t.textContent ?? "").replace(/\s/gu, " "),
    );
  const tally = tallyOf(ROWS, { 0: [1, 0] });
  const drawn = weekGrid(tally, false, ROOM);
  expect(texts(drawn, ".chart-week-days")).toEqual([
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ]);
  expect(texts(drawn, ".chart-week-hours")).toEqual([
    "12 AM",
    "3 AM",
    "6 AM",
    "9 AM",
    "12 PM",
    "3 PM",
    "6 PM",
    "9 PM",
  ]);
  expect(texts(weekGrid(tally, false, LEAST), ".chart-week-hours")).toEqual([
    "12 AM",
    "6 AM",
    "12 PM",
    "6 PM",
  ]);
});

test("a week heatmap's hours stand as close as their labels let them, in each language", async () => {
  expect([hourStep(ROOM, 3), hourStep(LEAST, 3)]).toEqual([3, 6]);
  await setLocale("es", { reload: false });
  // "18" is two characters where "12 AM" is five.
  expect([hourStep(ROOM, 3), hourStep(LEAST, 3)]).toEqual([2, 3]);
  const drawn = weekGrid(tallyOf(ROWS, { 0: [1, 0] }), false, ROOM);
  const days = [...drawn.querySelectorAll(".chart-week-days .chart-tick")].map(
    (t) => t.textContent,
  );
  expect(days).toEqual(["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]);
});

/** What a target's box says, its readings' values and labels, spaces as one. */
const saidOf = (target: { said: () => Array<{ value: string; label: Node }> }): string =>
  target
    .said()
    .map(({ value, label }) => `${value} ${label.textContent}`)
    .join(" / ")
    .replace(/\s/gu, " ");

test("a week heatmap's cells each say their day and hour and what they hold", () => {
  const rows = tallyOf(ROWS, { [MONDAY_NINE]: [7, 0] });
  const targets = weekTargets(rows, false, weekGrid(rows, false, ROOM));
  expect(targets.all).toHaveLength(WEEK_HOURS);
  expect(saidOf(targets.all[MONDAY_NINE]!)).toBe("7 Monday, 9:00 AM to 10:00 AM");
  expect(saidOf(targets.all[0]!)).toBe("0 Sunday, 12:00 AM to 1:00 AM");
  const sums = tallyOf(SUMS, { [WEEK_HOURS - 1]: [2, -300] });
  const summed = weekTargets(sums, true, weekGrid(sums, true, ROOM));
  expect(saidOf(summed.all[WEEK_HOURS - 1]!)).toBe("-300 Saturday, 11:00 PM to 12:00 AM / 2 rows");
  expect(summed.all[WEEK_HOURS - 1]!.key).toBe("var(--div-4)");
});

test("the keys step a week heatmap's cursor along a day, to its ends, and to the days either side", () => {
  const tally = tallyOf(ROWS, { 0: [1, 0] });
  const { step, keys } = weekTargets(tally, false, weekGrid(tally, false, ROOM));
  const after = (key: string, at: number | undefined) => step!(key, at);
  expect(after("ArrowDown", undefined)).toBe(0);
  expect([
    after("ArrowRight", 0),
    after("ArrowLeft", 0),
    after("ArrowRight", DAY_HOURS - 1),
  ]).toEqual([1, 0, DAY_HOURS - 1]);
  expect([after("ArrowDown", MONDAY_NINE), after("ArrowUp", MONDAY_NINE)]).toEqual([
    MONDAY_NINE + DAY_HOURS,
    9,
  ]);
  expect([after("ArrowUp", 9), after("ArrowDown", WEEK_HOURS - 1)]).toEqual([9, WEEK_HOURS - 1]);
  expect([after("Home", MONDAY_NINE), after("End", MONDAY_NINE)]).toEqual([
    DAY_HOURS,
    2 * DAY_HOURS - 1,
  ]);
  expect(after("PageDown", 0)).toBeUndefined();
  expect(keys).toEqual(["ArrowDown", "ArrowUp"]);
});

test("a week heatmap of plain dates draws a cell per day, named by its day, and Down and Up step the days", () => {
  // Every row dated at midnight: Monday's 3 and Saturday's 1.
  const days = { ...tallyOf(ROWS, { [DAY_HOURS]: [3, 0], [6 * DAY_HOURS]: [1, 0] }), timed: 0 };
  const drawn = weekGrid(days, false, ROOM);
  expect(stepsOf(drawn)).toEqual(["", "3", "", "", "", "", "1"]);
  expect(drawn.querySelector(".chart-week-hours")).toBeNull();
  const targets = weekTargets(days, false, drawn);
  expect(saidOf(targets.all[1]!)).toBe("3 Monday");
  const after = (key: string, at: number) => targets.step!(key, at);
  expect([
    after("ArrowDown", 1),
    after("ArrowUp", 1),
    after("ArrowRight", 1),
    after("End", 1),
  ]).toEqual([2, 0, 1, 1]);
});
