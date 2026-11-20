/**
 * @fileoverview An over-time chart's columns drawn from one level of its
 * tally: a slot per period from the first to the last, zeros included, each
 * column its share of a y axis from zero, under zero for a sum below it, and
 * a gridline at each tick with the tick's label beside it.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { TimeLevel } from "@tally";
import { axis } from "@renderer/chart/axes";
import { COLUMN_PITCH_LEAST, columns, fitted, sized, upward } from "@renderer/chart/columns";
import type { Fitted } from "@renderer/chart/columns";
import { BARS_INSET } from "@renderer/chart/rows";
import { periodTargets } from "@renderer/chart/tooltip";
import type { Targets } from "@renderer/chart/tooltip";
import { TICK_GAP } from "@renderer/chart/scatter";
import { ROOM } from "../charted.ts";

/** Four days of rows from 2024-03-03, the third with none: ticked 0 to 4 by 1. */
const DAYS: TimeLevel = {
  per: "day",
  from: 19_785,
  span: 4,
  offset: 0,
  rows: [2, 4, 0, 1],
  sum: [150, -50, 0, Number.POSITIVE_INFINITY],
};

/** A level of `per` from the epoch, counting `rows` per period, and summing none. */
const levelOf = (per: TimeLevel["per"], rows: number[]): TimeLevel => ({
  per,
  from: 0,
  span: rows.length,
  offset: 0,
  rows,
  sum: [],
});

/** The sales export's 91 days of a quarter, as its tally sends them from days to years. */
const QUARTER = [
  levelOf(
    "day",
    Array.from({ length: 91 }, () => 53),
  ),
  levelOf(
    "week",
    Array.from({ length: 14 }, () => 344),
  ),
  levelOf("month", [1_604, 1_604, 1_604]),
  levelOf("quarter", [4_812]),
  levelOf("year", [4_812]),
];

/** Drawn as `fitted` reads it. */
const drawn = (level: TimeLevel): Fitted => ({ level, fits: true });

/** The slots of `box`. */
const slots = (box: HTMLElement): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>(".chart-periods > .chart-period"),
];

/** The share of the axis each slot's column takes, or null for a slot with none. */
const shares = (box: HTMLElement): Array<string | null> =>
  slots(box).map((slot) =>
    slot.querySelector(".chart-column") === null ? null : slot.style.getPropertyValue("--share"),
  );

test("each period has a slot in time order, an empty one too, its column its rows' share of an axis from zero", () => {
  const box = columns(drawn(DAYS), false, ROOM);
  expect(shares(box)).toStrictEqual(["0.5", "1", "0", "0.25"]);
  expect(box.style.getPropertyValue("--zero")).toBe("0");
  expect(slots(box).some((slot) => slot.classList.contains("below"))).toBe(false);
});

test("a sum under zero grows down from zero, and an infinite one as long as the longest finite on its side", () => {
  const box = columns(drawn(DAYS), true, ROOM);
  // The axis runs from -50 to 150 by 50, so zero stands a quarter of the way up.
  expect(box.style.getPropertyValue("--zero")).toBe("0.25");
  expect(shares(box)).toStrictEqual(["0.75", "0.25", "0", "0.75"]);
  expect(slots(box).map((slot) => slot.classList.contains("below"))).toStrictEqual([
    false,
    true,
    false,
    false,
  ]);
});

test("each tick has a gridline across the periods, and its label beside the plot at the same height", () => {
  const box = columns(drawn(DAYS), false, ROOM);
  const lines = [...box.querySelectorAll(".chart-gridlines .chart-grid.y")];
  const labels = [...box.querySelectorAll<HTMLElement>(".chart-ticks.y .chart-tick")];
  expect(labels.map((label) => label.textContent)).toStrictEqual(["0", "1", "2", "3", "4"]);
  expect(lines.map((line) => line.getAttribute("y1"))).toStrictEqual(
    labels.map((l) => l.style.top),
  );
  expect(labels.map((label) => label.style.top)).toStrictEqual(["100%", "75%", "50%", "25%", "0%"]);
  expect(box.style.getPropertyValue("--gutter")).toBe("1ch");
});

test("a period past the batch sent has its slot and no column, until its batch comes", () => {
  const box = columns(drawn({ ...DAYS, span: 6 }), false, ROOM);
  expect(shares(box)).toStrictEqual(["0.5", "1", "0", "0.25", null, null]);
});

test("a plot draws the finest level whose periods each get COLUMN_PITCH_LEAST px past the y axis's labels", () => {
  expect(fitted(QUARTER, false, ROOM)).toStrictEqual({ level: QUARTER[0], fits: true });
  // A window of the least width holds 14 weeks, and not 91 days.
  expect(fitted(QUARTER, false, { ...ROOM, width: 238 })?.level.per).toBe("week");
  expect(fitted([], false, ROOM)).toBeUndefined();
});

test("the y axis's labels take their room from the periods, a whole px, as chart.css lays them out", () => {
  // Ten periods ticked to 1,000, whose widest label takes 5 ch.
  const level = levelOf(
    "day",
    Array.from({ length: 10 }, () => 1_000),
  );
  const labels = Math.ceil(5 * ROOM.ch);
  const least = 2 * BARS_INSET + labels + TICK_GAP + level.span * COLUMN_PITCH_LEAST;
  expect(fitted([level], false, { ...ROOM, width: least })?.fits).toBe(true);
  expect(fitted([level], false, { ...ROOM, width: least - 1 })?.fits).toBe(false);
});

test("a plot with room for no level draws the coarsest, each column its whole slot", () => {
  const narrow = fitted(QUARTER, false, { ...ROOM, width: 2 * BARS_INSET });
  expect(narrow).toStrictEqual({ level: QUARTER.at(-1), fits: false });
  expect(columns(narrow!, false, ROOM).classList.contains("crowded")).toBe(true);
  expect(columns(drawn(DAYS), false, ROOM).classList.contains("crowded")).toBe(false);
});

test("the periods are labelled under their columns, each centred on its column's share of the periods", () => {
  const box = columns(drawn(DAYS), false, ROOM);
  const ticks = [...box.querySelectorAll<HTMLElement>(".chart-ticks.x .chart-tick")];
  expect(ticks.map((tick) => tick.textContent)).toStrictEqual([
    "Mar 3, 2024",
    "Mar 4",
    "Mar 5",
    "Mar 6",
  ]);
  expect(ticks.map((tick) => tick.style.getPropertyValue("--at"))).toStrictEqual([
    "0.125",
    "0.375",
    "0.625",
    "0.875",
  ]);
  expect(ticks[0]!.style.getPropertyValue("--wide")).toBe("11ch");
});

test("the keys and the pointer step through every period, a zero too, each named in full with its rows, or its sum and rows", () => {
  const counted = periodTargets(DAYS, false, columns(drawn(DAYS), false, ROOM));
  const said = (targets: Targets, i: number): string[] =>
    targets.all[i]!.said().map(({ value, label }) => `${value} ${label.textContent}`);
  expect(counted.all).toHaveLength(DAYS.span);
  expect(said(counted, 2)).toStrictEqual(["0 Tuesday, March 5, 2024"]);
  const box = columns(drawn(DAYS), true, ROOM);
  const summed = periodTargets(DAYS, true, box);
  expect(said(summed, 1)).toStrictEqual(["-50 Monday, March 4, 2024", "4 rows"]);
  const slot = box.querySelectorAll(".chart-period")[3]!;
  expect(summed.under(slot, 0, 0)).toBe(3);
  expect(summed.all[3]!.at).toBe(slot.querySelector(".chart-column"));
});

test("a plot of another kind of column takes the gridlines, labels and sizes an over-time chart's does", () => {
  const box = columns(drawn(DAYS), false, ROOM);
  const up = axis(0, Math.max(...DAYS.rows));
  const { span, grid, labels } = upward(up);
  expect(span).toBe(4);
  expect(grid.outerHTML).toBe(box.querySelector(".chart-gridlines")!.outerHTML);
  expect(labels.outerHTML).toBe(box.querySelector(".chart-ticks.y")!.outerHTML);
  const other = document.createElement("div");
  sized(other, up, false);
  expect(other.classList.contains("crowded")).toBe(true);
  for (const size of ["--zero", "--inset", "--gutter", "--tick-gap", "--bar-thick", "--bar-gap"]) {
    expect(other.style.getPropertyValue(size), size).toBe(box.style.getPropertyValue(size));
  }
});
