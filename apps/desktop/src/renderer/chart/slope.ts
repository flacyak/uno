/**
 * @fileoverview A slope chart: a line per value from its From end, left, to
 * its To end, right, on one scale, so it never reads as two. Every line wears
 * the accent, as its slope says whether it rose or fell. The lines and dots
 * are SVG in shares of the plot, as a scatter's points are.
 */

import type { SlopePlot } from "@document";
import type { SlopeTally } from "@engine";
import { el } from "@renderer/shell/util";
import type { Ended } from "@tally";
import { axis } from "./axes.ts";
import { BARS_INSET } from "./rows.ts";
import { POINT_RADIUS, gridline, mark, percent } from "./scatter.ts";

/** The ring of the window's ground round a dot, in px: the dataviz skill's 2 px. */
const RING = 2;

/** Where the From end and the To end stand across the plot. */
const ENDS_AT = ["0", "100%"] as const;

/** The most values a slope draws, the largest first: past a dozen, lines cross into a tangle. */
export const SLOPES_AT_MOST = 12;

/** A value a slope draws: its label, and where it stands at each state, none where it has no number there. */
export interface Sloped {
  label: string;
  ends: [number | undefined, number | undefined];
}

/** A slope's rows to draw, its two states, and the values it leaves out. */
export interface Slopes {
  rows: Sloped[];
  states: [string, string];
  /** The values past those drawn, which a line under the plot counts. */
  more: number;
}

/**
 * sloped gives the first SLOPES_AT_MOST of `tally`'s values as `plot`
 * measures them at each end: its rows, its sum, or its mean, none for an end
 * of no rows or of no number, and none at all for a value whose rows count
 * apart from their states, as its ends may lack some.
 */
export function sloped(plot: SlopePlot, tally: SlopeTally): Slopes {
  const at = ({ rows, sum, numbers }: Ended): number | undefined => {
    if (rows === 0) return undefined;
    if (plot.of === undefined) return rows;
    if (plot.measure === "sum") return sum;
    return numbers === 0 ? undefined : sum / numbers;
  };
  const rows = tally.values.map(({ value, ends, unsplit }): Sloped => ({
    label: value,
    ends: unsplit ? [undefined, undefined] : [at(ends[0]), at(ends[1])],
  }));
  const more = Math.max(rows.length - SLOPES_AT_MOST, 0) + tally.others.values;
  return { rows: rows.slice(0, SLOPES_AT_MOST), states: [plot.from, plot.to], more };
}

/** line gives a mark of class `cls` from `x1`, `y1` to `x2`, `y2` of the plot. */
function line(cls: string, x1: string, y1: string, x2: string, y2: string): SVGLineElement {
  const made = mark("line", cls);
  for (const [name, at] of Object.entries({ x1, y1, x2, y2 })) made.setAttribute(name, at);
  return made;
}

/**
 * slopes draws `rows` on two axes, a line per value between its ends on one
 * scale over every end, and a dot at each end, over every line.
 */
export function slopes({ rows }: Slopes): HTMLElement {
  const box = el("div", "chart-slope");
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--ring", `${RING}px`);
  box.style.setProperty("--dot-reach", `${POINT_RADIUS + RING}px`);
  const ends = rows.flatMap(({ ends: both }) => both.filter((at) => at !== undefined));
  const finite = ends.filter(Number.isFinite);
  const scale = finite.length === 0 ? axis(0, 0) : axis(Math.min(...finite), Math.max(...finite));
  const [low, high] = [scale.ticks[0]!, scale.ticks.at(-1)!];
  // SVG counts down from the top, and the scale up from its least.
  const y = (at: number) => percent(1 - Math.min(Math.max((at - low) / (high - low), 0), 1));
  const plot = mark("svg", "chart-slope-plot");
  plot.setAttribute("aria-hidden", "true");
  plot.append(...ENDS_AT.map((x) => gridline("y", x, "0", x, "100%")));
  const dots: SVGCircleElement[] = [];
  for (const [from, to] of rows.map((row) => row.ends)) {
    if (from !== undefined && to !== undefined) {
      plot.append(line("chart-slope-line", ENDS_AT[0], y(from), ENDS_AT[1], y(to)));
    }
    for (const [i, at] of [from, to].entries()) {
      if (at === undefined) continue;
      const dot = mark("circle", "chart-slope-dot");
      dot.setAttribute("cx", ENDS_AT[i]!);
      dot.setAttribute("cy", y(at));
      dot.setAttribute("r", `${POINT_RADIUS}`);
      dots.push(dot);
    }
  }
  // Every dot stands over every line, so no line runs across another's end.
  plot.append(...dots);
  box.append(plot);
  return box;
}
