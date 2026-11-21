/**
 * @fileoverview Parallel coordinates: an axis per column, evenly spaced, each
 * from its column's least to its most over every row, its name over it.
 */

import type { ParallelPlot } from "@document";
import type { ParallelTally } from "@engine";
import { columnLabel } from "@renderer/grid/rows";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { mark } from "./scatter.ts";

/** The least px between two axes; a narrower plot scrolls sideways. */
const AXIS_PITCH_LEAST = 40;
/** The lines a head stands on, every other axis's on the second, so each has two pitches' room. */
const HEAD_LINES = 2;

/** labels gives a row of `words` centred on the axes, the i-th on the (i mod `lines`)-th line, whole in its title. */
function labels(kind: string, words: readonly string[], lines: number): HTMLElement {
  const row = el("div", `chart-parallel-labels ${kind}`);
  row.style.setProperty("--lines", `${lines}`);
  for (const [i, said] of words.entries()) {
    const label = el("bdi", "chart-parallel-label", said);
    label.title = said;
    label.style.setProperty("--axis", `${i}`);
    label.style.setProperty("--line", `${i % lines}`);
    row.append(label);
  }
  return row;
}

/**
 * parallelLines draws `tally` as `plot` reads it: its columns' names over its
 * axes, and each axis's most over it and least under it.
 */
export function parallelLines(plot: ParallelPlot, tally: ParallelTally): HTMLElement {
  const count = plot.axes.length;
  const x = (i: number) => i / (count - 1);
  const svg = mark("svg", "chart-parallel-plot");
  svg.setAttribute("viewBox", "0 0 1 1");
  svg.setAttribute("preserveAspectRatio", "none");
  for (let i = 0; i < count; i++) {
    const axis = mark("line", "chart-parallel-axis");
    axis.setAttribute("x1", `${x(i)}`);
    axis.setAttribute("x2", `${x(i)}`);
    axis.setAttribute("y2", "1");
    svg.append(axis);
  }
  const box = el("div", "chart-parallel");
  box.style.setProperty("--axes", `${count}`);
  box.style.setProperty("--pitch-least", `${AXIS_PITCH_LEAST}px`);
  const names = plot.axes.map(({ header, col }) => columnLabel(header, col));
  box.append(
    labels("chart-parallel-heads", names, HEAD_LINES),
    labels("chart-parallel-most", tally.most.map(num), 1),
    svg,
    labels("chart-parallel-least", tally.least.map(num), 1),
  );
  // The axes keep their least pitch apart, and a narrower plot scrolls sideways.
  const along = el("div", "chart-along chart-scrolls themed-bar");
  along.append(box);
  return along;
}
