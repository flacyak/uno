/**
 * @fileoverview Parallel coordinates' drawing: an axis per column, evenly
 * spaced, in a plot that keeps them apart.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { ParallelPlot } from "@document";
import { parallel } from "@renderer/chart/kinds/parallel";
import { parallelLines } from "@renderer/chart/parallel";

const AXES = ["units", "revenue", "discount"].map((header, col) => ({ col, header }));
const PLOT: ParallelPlot = { t: "parallel", axes: AXES };
const ROOM = { width: 420, ch: 7 };
const SKIPPED = { blank: 0, unparsed: 0 };

test("parallel coordinates draw an axis per column, evenly spaced", () => {
  const drawn = parallelLines(PLOT);
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
