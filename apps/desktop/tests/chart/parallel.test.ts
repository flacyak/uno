/**
 * @fileoverview Parallel coordinates' drawing: an axis per column, evenly
 * spaced, in a plot that keeps them apart.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { ParallelPlot } from "@document";
import type { ParallelTally } from "@engine";
import { parallel } from "@renderer/chart/kinds/parallel";
import { parallelLines } from "@renderer/chart/parallel";

const AXES = ["units", "revenue", "discount"].map((header, col) => ({ col, header }));
const PLOT: ParallelPlot = { t: "parallel", axes: AXES };
const ROOM = { width: 420, ch: 7 };
const SKIPPED = { blank: 0, unparsed: 0 };

/** tallyOf is a tally of `values`, each axis from 0 to 10, 0 to 100 and 5 to 5. */
function tallyOf(values: number[][], plotted = values.length): ParallelTally {
  const coverage = { rows: plotted, total: plotted, complete: true };
  const rows = values.map((_, i) => i);
  return {
    t: "parallel",
    plot: PLOT,
    coverage,
    rows,
    values,
    plotted,
    least: [0, 0, 5],
    most: [10, 100, 5],
    skipped: SKIPPED,
  };
}

test("parallel coordinates draw an axis per column, evenly spaced", () => {
  const drawn = parallelLines(PLOT, tallyOf([]));
  const axes = [...drawn.querySelectorAll(".chart-parallel-axis")];
  expect(axes.map((axis) => axis.getAttribute("x1"))).toStrictEqual(["0", "0.5", "1"]);
  expect(
    drawn.querySelector<HTMLElement>(".chart-parallel")!.style.getPropertyValue("--axes"),
  ).toBe("3");
  const coverage = { rows: 0, total: 0, complete: true };
  const none = {
    t: "parallel",
    plot: PLOT,
    coverage,
    rows: [],
    values: [],
    plotted: 0,
    least: [],
    most: [],
    skipped: SKIPPED,
  } as const;
  expect(
    parallel(PLOT).drawing({ ...none, rows: [], values: [], least: [], most: [] }, ROOM)?.empty,
  ).toBe(true);
});

test("parallel coordinates name each axis over it, every other on a second line, with its most over it and its least under it", () => {
  const drawn = parallelLines(PLOT, tallyOf([]));
  const words = (kind: string) =>
    [...drawn.querySelectorAll(`.${kind} .chart-parallel-label`)].map((l) => l.textContent);
  expect(words("chart-parallel-heads")).toStrictEqual(["units", "revenue", "discount"]);
  expect(words("chart-parallel-most")).toStrictEqual(["10", "100", "5"]);
  expect(words("chart-parallel-least")).toStrictEqual(["0", "0", "5"]);
  const heads = [
    ...drawn.querySelectorAll<HTMLElement>(".chart-parallel-heads .chart-parallel-label"),
  ];
  expect(heads.map((h) => h.style.getPropertyValue("--line"))).toStrictEqual(["0", "1", "0"]);
  expect(heads[1]!.title).toBe("revenue");
});
