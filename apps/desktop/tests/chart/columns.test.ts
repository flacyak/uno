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
import { columns } from "@renderer/chart/columns";

/** Four days of rows from 2024-03-03, the third with none: ticked 0 to 4 by 1. */
const DAYS: TimeLevel = {
  per: "day",
  from: 19_785,
  span: 4,
  offset: 0,
  rows: [2, 4, 0, 1],
  sum: [150, -50, 0, Number.POSITIVE_INFINITY],
};

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
  const box = columns(DAYS, false);
  expect(shares(box)).toStrictEqual(["0.5", "1", "0", "0.25"]);
  expect(box.style.getPropertyValue("--zero")).toBe("0");
  expect(slots(box).some((slot) => slot.classList.contains("below"))).toBe(false);
});

test("a sum under zero grows down from zero, and an infinite one as long as the longest finite on its side", () => {
  const box = columns(DAYS, true);
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
  const box = columns(DAYS, false);
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
  const box = columns({ ...DAYS, span: 6 }, false);
  expect(shares(box)).toStrictEqual(["0.5", "1", "0", "0.25", null, null]);
});
