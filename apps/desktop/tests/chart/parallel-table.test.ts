/**
 * @fileoverview Parallel coordinates' table and summary: the rows drawn, by
 * their row, with their number at every axis, a line of the rows it left out,
 * and a sentence of its rows and each axis's least and most.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { ParallelPlot } from "@document";
import type { ParallelTally } from "@engine";
import { parallel } from "@renderer/chart/kinds/parallel";
import { LINES_DRAWN } from "@renderer/chart/parallel";
import { parallelOver } from "@renderer/chart/summary";
import { paralleled } from "@renderer/chart/table";

const AXES = ["units", "revenue", "discount"].map((header, col) => ({ col, header }));
const PLOT: ParallelPlot = { t: "parallel", axes: AXES };
const COVERAGE = { rows: 9, total: 9, complete: true };
const SKIPPED = { blank: 0, unparsed: 0 };
const TALLY: ParallelTally = {
  t: "parallel",
  plot: PLOT,
  coverage: COVERAGE,
  rows: [6, 2],
  values: [
    [10, 25, 5],
    [0, 100, 5],
  ],
  plotted: 5,
  least: [0, 25, 5],
  most: [10, 100, 5],
  skipped: SKIPPED,
};

/** lines gives a table's rows as their cells' words. */
const lines = ([heads, rows]: [HTMLElement[], HTMLElement[]]) => [
  heads.map((h) => h.textContent).join(" | "),
  ...rows.map((r) => [...r.children].map((c) => c.textContent).join(" | ")),
];

test("parallel coordinates' table lists the rows drawn by their row, with their number at every axis, and the rows it did not draw", () => {
  expect(lines(paralleled(PLOT, TALLY))).toStrictEqual([
    "row | units | revenue | discount",
    "3 | 0 | 100 | 5",
    "7 | 10 | 25 | 5",
    "3 rows not sampled",
  ]);
  const many = Array.from({ length: LINES_DRAWN + 1 }, (_, i) => [i, i, i]);
  const rows = many.map((_, i) => i);
  const [, listed] = paralleled(PLOT, { ...TALLY, values: many, rows, plotted: many.length });
  expect(listed).toHaveLength(LINES_DRAWN + 1);
  expect(listed.at(-1)!.textContent).toBe("1 row not sampled");
});

test("parallel coordinates' summary says their rows and each axis's least and most, and their kind gives both", () => {
  expect(parallelOver(PLOT, TALLY)).toStrictEqual({
    span: "5 rows: units from 0 to 10, revenue from 25 to 100, discount from 5 to 5.",
    each: [],
    more: 0,
  });
  const drawing = parallel(PLOT).drawing(TALLY, { width: 420, ch: 7 })!;
  expect(drawing.told()).toStrictEqual(parallelOver(PLOT, TALLY));
  expect(drawing.table(document.createTextNode("")).querySelectorAll("tbody tr")).toHaveLength(3);
});
