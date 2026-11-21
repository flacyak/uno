/**
 * @fileoverview Parallel coordinates: an axis per column, evenly spaced, each
 * from its column's least to its most over every row, and a faint line per
 * sampled row across them, so where lines crowd reads as density.
 */

import type { ParallelPlot } from "@document";
import type { ParallelTally } from "@engine";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { revealed } from "./histogram.ts";
import { BARS_INSET } from "./rows.ts";
import { mark } from "./scatter.ts";
import { ACCENT, HIT_RADIUS, column } from "./tooltip.ts";
import type { Reading, Target, Targets } from "./tooltip.ts";
import { stepsOf } from "./week.ts";

/** The rows parallel coordinates draw a line of, the first by rank: the owner's 562, against 512. */
export const LINES_DRAWN = 562;
/** How strong a line's ink is, so a lone line reads faint and a crowd of them dark. */
const LINE_OPACITY = 0.15;
/** The least px between two axes; a narrower plot scrolls sideways. */
const AXIS_PITCH_LEAST = 40;
/** The lines a head stands on, every other axis's on the second, so each has two pitches' room. */
const HEAD_LINES = 2;

/** at gives where `n` stands on an axis from `least` at its foot, 1, to `most` at its head, 0. */
function at(n: number, least: number, most: number): number {
  return most === least ? 1 / 2 : (most - n) / (most - least);
}

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
 * axes, each axis's most over it and least under it, and a line of each of
 * the first LINES_DRAWN sampled rows.
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
  for (const values of tally.values.slice(0, LINES_DRAWN)) {
    const line = mark("polyline", "chart-parallel-line");
    const points = values.map((n, i) => `${x(i)},${at(n, tally.least[i]!, tally.most[i]!)}`);
    line.setAttribute("points", points.join(" "));
    svg.append(line);
  }
  const box = el("div", "chart-parallel");
  box.style.setProperty("--axes", `${count}`);
  box.style.setProperty("--pitch-least", `${AXIS_PITCH_LEAST}px`);
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--line-opacity", `${LINE_OPACITY}`);
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

/** A point in the page, in px. */
type Px = readonly [x: number, y: number];

/** apart gives how far `p` stands from the segment from `a` to `b`, in px. */
function apart([px, py]: Px, [ax, ay]: Px, [bx, by]: Px): number {
  const [dx, dy] = [bx - ax, by - ay];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/** The keys parallel coordinates' targets step past the tooltip's: to the next line and the one before. */
const LINE_STEP = ["ArrowDown", "ArrowUp"] as const;

/**
 * parallelTargets gives each line of `drawn` at each of its axes, as
 * parallelLines drew `tally` for `plot`, line by line in rank order, so Right
 * and Left step along a line, Home and End to its ends, and Down and Up to the
 * line after and before at the same axis. Each says its number at its axis and
 * its row, by its point, which the keys scroll into sight. A pointer's target
 * is the line nearest it within HIT_RADIUS, at the axis nearest it.
 */
export function parallelTargets(
  plot: ParallelPlot,
  tally: ParallelTally,
  drawn: HTMLElement,
): Targets {
  const svg = drawn.querySelector(".chart-parallel-plot")!;
  const lines = [...drawn.querySelectorAll(".chart-parallel-line")];
  const count = plot.axes.length;
  const shares = lines.map((_, r) =>
    tally.values[r]!.map((n, a): Px => [a / (count - 1), at(n, tally.least[a]!, tally.most[a]!)]),
  );
  const inPage = ([x, y]: Px): Px => {
    const box = svg.getBoundingClientRect();
    return [box.left + x * box.width, box.top + y * box.height];
  };
  // A point comes into sight with the room the drawing keeps past its end axes, so its numbers show.
  const room = () => parseFloat(getComputedStyle(svg.parentElement!).paddingLeft);
  const all = lines.flatMap((line, r) =>
    plot.axes.map((_, a): Target => {
      const spot = () => new DOMRect(...inPage(shares[r]![a]!));
      const said = (): Reading[] => {
        const [label, row] = [el("span"), m.chart_swarm_row({ row: num(tally.rows[r]! + 1) })];
        label.append(column(plot.axes[a]!), `, ${row}`);
        return [{ value: num(tally.values[r]![a]!), label }];
      };
      const reveal = () => {
        const [x, y] = inPage(shares[r]![a]!);
        revealed(line, new DOMRect(x - room(), y, 2 * room(), 0));
      };
      return { mark: line, at: line, spot, front: true, key: ACCENT, said, reveal };
    }),
  );
  const under = (_hit: EventTarget | null, x: number, y: number): number | undefined => {
    const box = svg.getBoundingClientRect();
    let [near, least]: [number | undefined, number] = [undefined, HIT_RADIUS];
    for (const [r, points] of shares.entries()) {
      const page = points.map(inPage);
      for (let a = 1; a < count; a++) {
        const by = apart([x, y], page[a - 1]!, page[a]!);
        if (by <= least) [near, least] = [r, by];
      }
    }
    if (near === undefined) return undefined;
    const along = Math.max(0, Math.min(1, (x - box.left) / box.width));
    return near * count + Math.round(along * (count - 1));
  };
  const steps = stepsOf(count, all.length);
  const step = (key: string, at: number | undefined): number | undefined => {
    if (at !== undefined) return steps.get(key)?.(at);
    return key === LINE_STEP[0] ? 0 : key === LINE_STEP[1] ? all.length - count : undefined;
  };
  return { all, under, step, keys: LINE_STEP };
}
