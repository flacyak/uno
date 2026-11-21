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
import { LINES_DRAWN, parallelLines, parallelTargets } from "@renderer/chart/parallel";
import { TIP_OFFSET, Tooltip } from "@renderer/chart/tooltip";
import { el } from "@renderer/shell/util";

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

/** Lays `at` out as a page would: `rect` is its box, and the sizes it reads. */
function laidOut(at: Element, rect: DOMRect): void {
  Object.defineProperties(at, {
    getBoundingClientRect: { value: () => rect },
    clientWidth: { value: rect.width },
    clientHeight: { value: rect.height },
    offsetWidth: { value: rect.width },
    offsetHeight: { value: rect.height },
  });
}

/** The plot's box in the page: its axes stand at 100, 200 and 300 px, from 50 px down to 150. */
const PLOTTED = new DOMRect(100, 50, 200, 100);
/** The window the box stands in, and the box's size, each roomy enough to keep the box where it stands. */
const WINDOW = new DOMRect(0, 0, 400, 300);
const BOX = new DOMRect(0, 0, 80, 60);

test("parallel coordinates' targets step each line along its axes with Right and Left, to the next line with Down and Up, and say its number at its axis and its row", () => {
  const tally = {
    ...tallyOf([
      [10, 25, 5],
      [0, 100, 5],
    ]),
    rows: [4, 9],
  };
  const drawn = parallelLines(PLOT, tally);
  laidOut(drawn.querySelector(".chart-parallel-plot")!, PLOTTED);
  const targets = parallelTargets(PLOT, tally, drawn);
  expect(targets.all).toHaveLength(6);
  const read = (i: number) =>
    targets.all[i]!.said().map((r) => `${r.value} ${r.label.textContent}`);
  expect(read(1)).toStrictEqual(["25 revenue, row 5"]);
  expect(read(3)).toStrictEqual(["0 units, row 10"]);
  expect(targets.step?.("ArrowDown", 1)).toBe(4);
  expect(targets.step?.("ArrowUp", 4)).toBe(1);
  expect(targets.step?.("ArrowRight", 2)).toBe(2);
  expect(targets.step?.("End", 3)).toBe(5);
  expect(targets.step?.("ArrowDown", undefined)).toBe(0);
  expect(targets.step?.("ArrowUp", undefined)).toBe(3);
  expect(targets.step?.("ArrowRight", undefined)).toBeUndefined();
  // The second line's point on the last axis, and the pointer at it: the line, at that axis.
  const spot = targets.all[5]!.spot!();
  expect([spot.x, spot.y]).toStrictEqual([300, 100]);
  expect(targets.under(null, 298, 96)).toBe(5);
  // Between the first two axes, nearer the first line than the second: the first line, at the nearer axis.
  expect(targets.under(null, 160, 97)).toBe(1);
  expect(targets.under(null, 160, 120)).toBeUndefined();
});

test("a step along one line says its number at the axis it is at, and stands the box by that axis's point", () => {
  const tally = tallyOf([[10, 25, 5]]);
  const drawn = parallelLines(PLOT, tally);
  const within = el("div");
  within.append(drawn);
  document.body.append(within);
  laidOut(drawn.querySelector(".chart-parallel-plot")!, PLOTTED);
  laidOut(within, WINDOW);
  const tip = new Tooltip(drawn, within, "tip");
  within.append(tip.box);
  laidOut(tip.box, BOX);
  tip.show(parallelTargets(PLOT, tally, drawn));
  const press = (key: string) =>
    tip.step({ key, ctrl: false, alt: false, meta: false, shift: false, repeat: false });
  const said = () => tip.box.querySelector(".chart-tip-words")?.textContent;
  press("ArrowRight");
  expect(said()).toBe("10 units, row 1");
  expect(drawn.querySelector(".chart-parallel-line.cursor")).not.toBeNull();
  press("ArrowRight");
  expect(said()).toBe("25 revenue, row 1");
  expect(tip.box.style.left).toBe(`${200 + TIP_OFFSET}px`);
});
