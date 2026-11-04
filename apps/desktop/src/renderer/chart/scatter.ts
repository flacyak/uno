/**
 * @fileoverview A scatter chart: a point per sampled row, where its x and y
 * stand on two axes that take in every plotted row.
 *
 * The points are SVG placed in shares of the plot, so whatever sizes the plot
 * places them.
 */

import type { Sample } from "@engine";
import { el } from "@renderer/shell/util";
import { axis } from "./axes.ts";
import type { Axis } from "./axes.ts";

/** A point's radius, in px: the dataviz skill's least marker, 8 px across. */
export const POINT_RADIUS = 4;

/** The namespace an SVG element is made in. */
const SVG = "http://www.w3.org/2000/svg";

/** mark makes an SVG `tag` of class `cls`. */
function mark<K extends keyof SVGElementTagNameMap>(tag: K, cls: string): SVGElementTagNameMap[K] {
  const made = document.createElementNS(SVG, tag);
  made.setAttribute("class", cls);
  return made;
}

/** share gives where `value` stands on `axis`, from 0 at its first tick to 1 at its last. */
function share(axis: Axis, value: number): number {
  const low = axis.ticks[0]!;
  return (value - low) / (axis.ticks.at(-1)! - low);
}

/** percent writes `share` of the plot as SVG takes it. */
function percent(share: number): string {
  return `${share * 100}%`;
}

/**
 * scales says whether `axis` gives a scale: two ticks or more, each finite, and
 * a span between them that a double holds.
 */
function scales(axis: Axis): boolean {
  const { ticks } = axis;
  const span = ticks.at(-1)! - ticks[0]!;
  return ticks.length >= 2 && ticks.every(Number.isFinite) && Number.isFinite(span);
}

/**
 * scatter draws `sample`'s points against axes over its least and most. A
 * tally that plotted nothing has no extent to draw, and where no double can
 * scale an axis its points would stand at NaN, so either draws nothing.
 */
export function scatter(sample: Sample): HTMLElement {
  const box = el("div", "chart-scatter");
  const x = axis(sample.least.x, sample.most.x);
  const y = axis(sample.least.y, sample.most.y);
  if (sample.plotted === 0 || !scales(x) || !scales(y)) return box;

  const plot = mark("svg", "chart-points");
  plot.setAttribute("aria-hidden", "true");
  for (const [i, at] of sample.x.entries()) {
    const point = mark("circle", "chart-point");
    point.setAttribute("cx", percent(share(x, at)));
    // SVG counts down from the top, and an axis up from its first tick.
    point.setAttribute("cy", percent(1 - share(y, sample.y[i]!)));
    point.setAttribute("r", `${POINT_RADIUS}`);
    plot.append(point);
  }
  box.append(plot);
  return box;
}
