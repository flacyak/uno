/**
 * @fileoverview Parallel coordinates' drawing: an axis per column, a line of
 * each of the first LINES_DRAWN sampled rows through each axis's least and
 * most, its names over the axes on two lines in turn, and a caption of how
 * many rows it drew of every row.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { ParallelPlot } from "@document";
import type { ParallelTally } from "@engine";
import { parallel } from "@renderer/chart/kinds/parallel";
import { LINES_DRAWN, parallelLines } from "@renderer/chart/parallel";

const AXES = ["units", "revenue", "discount"].map((header, col) => ({ col, header }));
const PLOT: ParallelPlot = { t: "parallel", axes: AXES };
const ROOM = { width: 420, ch: 7 };
/** More sampled rows than are drawn. */
const SAMPLED = LINES_DRAWN + 10;

/** tallyOf is a tally of `values`, of `plotted` rows, each axis from 0 to 10, 0 to 100 and 5 to 5. */
function tallyOf(values: number[][], plotted = values.length): ParallelTally {
  const coverage = { rows: plotted, total: plotted, complete: true };
  const rows = values.map((_, i) => i);
  const skipped = { blank: 0, unparsed: 0 };
  return {
    t: "parallel",
    plot: PLOT,
    coverage,
    rows,
    values,
    plotted,
    least: [0, 0, 5],
    most: [10, 100, 5],
    skipped,
  };
}

test("parallel coordinates draw an axis per column and a line of each of the first rows, from each axis's most at its head to its least at its foot", () => {
  const values = Array.from({ length: SAMPLED }, () => [10, 25, 5]);
  const drawn = parallelLines(PLOT, tallyOf(values));
  expect(drawn.querySelectorAll(".chart-parallel-axis")).toHaveLength(AXES.length);
  const lines = drawn.querySelectorAll(".chart-parallel-line");
  expect(lines).toHaveLength(LINES_DRAWN);
  // 10 heads its axis, 25 stands three quarters down, and an axis of one number holds it midway.
  expect(lines[0]!.getAttribute("points")).toBe("0,0 0.5,0.75 1,0.5");
  const words = (kind: string) =>
    [...drawn.querySelectorAll(`.${kind} .chart-parallel-label`)].map((l) => l.textContent);
  expect(words("chart-parallel-heads")).toStrictEqual(["units", "revenue", "discount"]);
  expect(words("chart-parallel-most")).toStrictEqual(["10", "100", "5"]);
  expect(words("chart-parallel-least")).toStrictEqual(["0", "0", "5"]);
  const lineOf = (i: number) =>
    drawn
      .querySelectorAll<HTMLElement>(".chart-parallel-heads .chart-parallel-label")
      [i]!.style.getPropertyValue("--line");
  expect([0, 1, 2].map(lineOf)).toStrictEqual(["0", "1", "0"]);
});

test("parallel coordinates' caption counts the lines drawn of every row, as a sample, and nothing when it drew every row", () => {
  const values = Array.from({ length: SAMPLED }, () => [1, 2, 5]);
  expect(parallel(PLOT).drawing(tallyOf(values, 12_900_000), ROOM)!.notes()).toStrictEqual([
    "562 of 12,900,000 rows, a sample",
  ]);
  expect(
    parallel(PLOT)
      .drawing(tallyOf(values.slice(0, 3)), ROOM)!
      .notes(),
  ).toStrictEqual([]);
  expect(parallel(PLOT).drawing(tallyOf([], 0), ROOM)?.empty).toBe(true);
});
